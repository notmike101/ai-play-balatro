// mc.mjs — Monte-Carlo hold EV over the REAL unseen-deck multiset (pure, no game link).
/* COHORT-23 (11-04 user directive "Monte Carlo or play better"): replace the linear
   outs heuristic (play.drawEV, single-best-draw, additive P) with sampled truth:
   for each candidate keep, simulate the refill draws from the actual remaining deck
   (composition manifest minus run-seen cards, joint rank+suit+enh) and average the
   resulting hand value. Catches what the heuristic structurally cannot: joint
   outcomes (one card completing two outs), multi-draw compounding, High-Card/Two-Pair
   intermediate improvements, and deck depletion after enhancement farms.
   Value units MATCH drawScore (FAMS + scoring chips) so chooseDiscard mixes both
   paths and the steel-held multiplier semantics stay unchanged. */
import { rv, CHIP } from './eval.mjs';

/* family value scale - single source now lives HERE (play.mjs imports it) */
const FAMS = {
    'Straight Flush': 5e6, 'Four of a Kind': 4e5, 'Full House': 3.5e5, Flush: 3e5, Straight: 2e5, 'Three of a Kind': 1.5e5, 'Two Pair': 4e4, Pair: 1e4, 'High Card': 0,
};
const ORDER = ['Straight Flush', 'Four of a Kind', 'Full House', 'Flush', 'Straight', 'Three of a Kind', 'Two Pair', 'Pair', 'High Card'];

/**
 * Seeded 32-bit PRNG (mulberry32): decisions must be REPRODUCIBLE - the calibration
 * loop folds observed plays against the pred the SAME hand produced.
 *
 * @param {number} a - seed
 * @returns {function(): number} uniform [0,1) generator
 */
function mulberry32(a) {
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);

        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Best-window straight scan over a rank set (Ace both ends).
 *
 * @param {Set<number>} set - distinct numeric ranks
 * @returns {number} highest straight window (A-low = 1), 0 when none
 */
function straightWin(set) {
    for (let w = 10; w >= 1; w--) {
        if (set.has(w) && set.has(w + 1) && set.has(w + 2) && set.has(w + 3) && set.has(w + 4)) {
            return w;
        }
    }

    if (set.has(14) && set.has(2) && set.has(3) && set.has(4) && set.has(5)) {
        return 1;
    }

    return 0;
}

/**
 * Family + scoring chips of the BEST 5-card hand inside 5..8 cards, count-based
 * (no subset enumeration): straight/flush chip sums use the winning set.
 *
 * @param {object[]} cs - 5..8 cards {rank(numeric), suit}
 * @returns {{fam: string, chips: number}} value parts (FAMS-scale fam, scoring chips)
 */
function famChips(cs) {
    const cnt = {};
    const suitCards = {};

    for (const c of cs) {
        const v = rv(c);

        cnt[v] = (cnt[v] || 0) + 1;
        (suitCards[c.suit] ??= []).push(v);
    }

    const rset = new Set(Object.keys(cnt).map(Number));
    let flushSuit = null;

    for (const [s, arr] of Object.entries(suitCards)) {
        if (arr.length >= 5 && (!flushSuit || arr.length > suitCards[flushSuit].length)) {
            flushSuit = s;
        }
    }

    const groups = Object.entries(cnt).map(([r, n]) => [Number(r), n]).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const ch = (v) => CHIP(v);
    const topOf = (arr, n) => [...arr].sort((a, b) => ch(b) - ch(a)).slice(0, n).reduce((s, v) => s + ch(v), 0);
    const winChips = (set) => {
        let bestC = 0;

        for (let w = 1; w <= 10; w++) {
            const hit = (w === 1 && set.has(14) && set.has(2) && set.has(3) && set.has(4) && set.has(5))
                || [0, 1, 2, 3, 4].every((o) => set.has(w + o));

            if (hit) {
                const ranks = w === 1 && set.has(14) && !set.has(6) && [2, 3, 4, 5].every((r) => set.has(r)) ? [14, 2, 3, 4, 5] : [w, w + 1, w + 2, w + 3, w + 4];
                const c = ranks.reduce((s, r) => s + ch(r), 0);

                if (c > bestC) {
                    bestC = c;
                }
            }
        }

        return bestC;
    };

    if (flushSuit) {
        const sSet = new Set(suitCards[flushSuit]);

        if (straightWin(sSet)) {
            return { fam: 'Straight Flush', chips: winChips(sSet) };
        }
    }

    if (groups[0][1] === 4) {
        const kick = Object.entries(cnt).filter(([r]) => Number(r) !== groups[0][0]).map(([r]) => Number(r)).sort((a, b) => ch(b) - ch(a))[0];

        return { fam: 'Four of a Kind', chips: 4 * ch(groups[0][0]) + (kick === undefined ? 0 : ch(kick)) };
    }

    if (groups[0][1] === 3 && groups[1] && groups[1][1] >= 2) {
        return { fam: 'Full House', chips: 3 * ch(groups[0][0]) + 2 * ch(groups[1][0]) };
    }

    if (flushSuit) {
        return { fam: 'Flush', chips: topOf(suitCards[flushSuit], 5) };
    }

    if (straightWin(rset)) {
        return { fam: 'Straight', chips: winChips(rset) };
    }

    if (groups[0][1] === 3) {
        return { fam: 'Three of a Kind', chips: 3 * ch(groups[0][0]) };
    }

    if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) {
        return { fam: 'Two Pair', chips: 2 * ch(groups[0][0]) + 2 * ch(groups[1][0]) };
    }

    if (groups[0][1] === 2) {
        return { fam: 'Pair', chips: 2 * ch(groups[0][0]) };
    }

    return { fam: 'High Card', chips: ch(Math.max(...rset)) };
}

/**
 * One simulated hand value (focal-level boost on the grind family only, matching
 * the drawEV boost semantics so focal levels keep pulling keeps toward the grind).
 *
 * @param {object[]} hand - keep + drawn cards
 * @param {object} ctx - {fam, lvl}
 * @returns {number} FAMS-scale value
 */
function simVal(hand, ctx) {
    const { fam, chips } = famChips(hand);
    const boost = ctx && fam === ctx.fam ? 1 + 0.35 * (Math.max(1, ctx.lvl || 1) - 1) : 1;

    return FAMS[fam] * boost + chips;
}

/**
 * Expected value of keeping `keep` and refilling with d fresh deck cards.
 *
 * @param {object[]} keep - 5-card keep (rank numeric or name form via rv)
 * @param {number} d - refill count (hand size - 5)
 * @param {object} ctx - {udeck: {rank,suit}[] | null, fam, lvl, seed, N}
 * @returns {(number|null)} mean value, null when deck/d unavailable (caller falls back)
 */
function mcHold(keep, d, ctx) {
    const deck = ctx && ctx.udeck;

    if (!Array.isArray(deck) || deck.length < 10 || !d) {
        return null;
    }

    let seed = ctx.seed || 0;

    for (const c of keep) {
        seed = (seed * 31 + (c.id ?? 0) + rv(c) * 7) | 0;
    }

    const rng = mulberry32(seed + d * 101 + ORDER.length);
    const N = ctx.N || 96;
    const dl = deck.slice();
    const k = Math.min(d, dl.length);
    let tot = 0;

    for (let s = 0; s < N; s++) {
        /* full Fisher-Yates per sim: uniform without-replacement draws */
        for (let i = 0; i < dl.length - 1; i++) {
            const j = i + Math.floor(rng() * (dl.length - i));
            const t = dl[i];

            dl[i] = dl[j];
            dl[j] = t;
        }

        tot += simVal(keep.concat(dl.slice(0, k)), ctx);
    }

    return tot / N;
}

export { FAMS, ORDER, famChips, mcHold, mulberry32 };
