// mc.mjs — Monte-Carlo hold EV over the REAL unseen-deck multiset (pure, no game link).
/* COHORT-23 (11-04 user directive "Monte Carlo or play better"): replace the linear
   outs heuristic (play.drawEV, single-best-draw, additive P) with sampled truth:
   for each candidate keep, simulate the refill draws from the actual remaining deck
   (composition manifest minus run-seen cards, joint rank+suit+enh) and average the
   resulting hand value. Catches what the heuristic structurally cannot: joint
   outcomes (one card completing two outs), multi-draw compounding, High-Card/Two-Pair
   intermediate improvements, and deck depletion after enhancement farms.
   VALUE TARGET (11-05 user correction "still optimizes a heuristic, not actual
   scoring"): with the hands table supplied (ctx.ht, always present at decision
   time) the sampled value is the REAL score the game prints - (base chips at the
   family's CURRENT LEVEL + scoring card chips) x base mult - so level asymmetry
   between families is truth, not the old 0.35/level proxy. The FAMS scale stays ONLY
   as the hands-table-less fallback (tests, manifest-unknown obs); one chooseDiscard
   run never mixes the two scales. */
import { rv, CHIP, famBase } from './eval.mjs';

/* Stone Card (11-05 TRUTH: blob23 loc "m_stone = +N Chips, no rank or suit"; blob4
   get_chip_bonus reads ability.bonus): scores a FLAT chip bonus, contributes NO
   rank/suit - it cannot complete flushes, straights or pairs. Its center config VALUE
   is not in the shipped blobs (center table not shipped); vanilla 50 assumed - the
   Stone-JOKER synergy (+25 per deck stone, cfg extra=25) is truth and lives in
   jmodel.knownLayer, NOT here. */
const STONE_B = 50;
/* scoring-card count per family - how many slots stones can fill */
const FAMSZ = {
    'Straight Flush': 5, 'Four of a Kind': 5, 'Full House': 5, Flush: 5, Straight: 5,
    'Three of a Kind': 3, 'Two Pair': 4, Pair: 2, 'High Card': 1,
};

/**
 * Enhancement key of a card, tolerant across observation (key) and deck-manifest (enh) shapes.
 *
 * @param {object} c - card-like
 * @returns {string} lowercased enhancement key or ''
 */
const enhOf = (c) => {
    if (c.enh === undefined || c.enh === null) {
        return String(typeof c.key === 'string' ? c.key : '').toLowerCase();
    }

    return String(c.enh).toLowerCase();
};

/**
 * Stone-card predicate for sim draws (rank-less, suit-less flat-chip cards).
 *
 * @param {object} c - card-like
 *
 * @returns {boolean} true for Stone Cards
 */
const isStoneCard = (c) => enhOf(c).includes('stone');

/* family value scale - single source now lives HERE (play.mjs imports it) */
const FAMS = {
    'Straight Flush': 5e6, 'Four of a Kind': 4e5, 'Full House': 3.5e5, Flush: 3e5, Straight: 2e5, 'Three of a Kind': 1.5e5, 'Two Pair': 4e4, Pair: 1e4, 'High Card': 0,
};
const ORDER = ['Straight Flush', 'Four of a Kind', 'Full House', 'Flush', 'Straight', 'Three of a Kind', 'Two Pair', 'Pair', 'High Card'];

/**
 * Single-card chip value for an encoded rank (2..14) in sim scoring.
 *
 * @param {number} v - encoded rank
 *
 * @returns {number} chips that rank contributes when it scores
 */
const ch = (v) => CHIP(v);

/**
 * Sum of the n best chip values in a rank array (sorted copy).
 *
 * @param {number[]} arr - encoded ranks
 * @param {number} n - how many top ranks to take
 *
 * @returns {number} total chips of the n highest-value ranks
 */
const topOf = (arr, n) => [...arr].sort((a, b) => ch(b) - ch(a)).slice(0, n).reduce((s2, v) => s2 + ch(v), 0);

/**
 * Best straight chips a rank set can score: max over the 10 five-rank windows
 * fully contained in the set, wheel-aware (A plays 14-2-3-4-5 with those exact
 * chip cards when no 6 extends the window).
 *
 * @param {Set<number>} set - encoded ranks present
 *
 * @returns {number} chip total of the best contained straight, 0 if none
 */
const winChips = (set) => {
    let bestC = 0;

    for (let w = 1; w <= 10; w++) {
        const hit = (w === 1 && set.has(14) && set.has(2) && set.has(3) && set.has(4) && set.has(5))
            || [0, 1, 2, 3, 4].every((o) => set.has(w + o));

        if (hit) {
            const ranks = w === 1 && set.has(14) && !set.has(6) && [2, 3, 4, 5].every((r) => set.has(r)) ? [14, 2, 3, 4, 5] : [w, w + 1, w + 2, w + 3, w + 4];
            const c = ranks.reduce((s2, r) => s2 + ch(r), 0);

            if (c > bestC) {
                bestC = c;
            }
        }
    }

    return bestC;
};

/**
 * Seeded 32-bit PRNG (mulberry32): decisions must be REPRODUCIBLE - the calibration
 * loop folds observed plays against the pred the SAME hand produced.
 *
 * @param {number} a - seed
 * @returns {function(): number} uniform [0,1) generator
 */
function mulberry32(a) {
    return () => {
        /* eslint-disable-next-line unicorn/prefer-math-trunc -- |0 keeps 32-bit WRAP semantics Math.trunc lacks */
        a = (a + 0x6D_2B_79_F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);

        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
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
function famInner(cs) {
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
 * Family + scoring chips of the best 5-card hand, with STONE CARDS removed from
 * detection and their flat bonus added back into the scoring chips (stone fills a
 * scoring slot, contributes no rank/suit - 11-05 TRUTH semantics).
 *
 * @param {object[]} cs - 5..8 cards {rank, suit, enh?/key?}
 * @returns {{fam: string, chips: number}} detected family + scoring chips
 */
function famChips(cs) {
    let stoneN = 0;
    let plain = cs;

    if (cs.some(isStoneCard)) {
        plain = [];

        for (const c of cs) {
            if (isStoneCard(c)) {
                stoneN += 1;
            } else {
                plain.push(c);
            }
        }

        /* Detection runs on the rank-bearing cards ONLY, even at 1..4 of them - a
           played 5-card hand with stones pads out with rank-less cards (famInner
           handles <5: no flush/straight possible, High Card = best plain rank).
           All-stone hand: no detectable family at all. */
        if (plain.length === 0) {
            return { fam: 'High Card', chips: Math.min(cs.length, 5) * STONE_B };
        }
    }

    const r = famInner(plain);
    const slots = FAMSZ[r.fam] ?? 5;

    return { fam: r.fam, chips: r.chips + STONE_B * Math.min(stoneN, Math.max(0, 5 - slots)) };
}

/**
 * One simulated hand value. REAL SCORE when the hands table is known (ctx.ht):
 * (hands-table base chips AT CURRENT LEVEL + scoring chips) x base mult - the actual
 * number the game would print for that family, focal level included truth-fully via
 * the table rows. Joker layers are omitted (same lineup on every candidate keep;
 * they cancel in the ranking). Without ctx.ht the legacy FAMS proxy + 0.35/level
 * focal boost remains (deckless obs, unit tests). Steel held-in-play X1.5 per
 * scored steel card applies in both paths (oracle held rule).
 *
 * @param {object[]} hand - keep + drawn cards
 * @param {object} ctx - {ht?, fam, lvl}
 * @returns {number} real score estimate, or FAMS-scale value on the legacy path
 */
function simVal(hand, ctx) {
    const { fam, chips } = famChips(hand);
    let steelN = 0;

    for (const c of hand) {
        if (enhOf(c).includes('steel')) {
            steelN += 1;
        }
    }

    if (ctx && Array.isArray(ctx.ht) && ctx.ht.length) {
        const b = famBase(ctx.ht, fam);

        return (b.chips + chips) * b.mult * (1.5 ** steelN);
    }

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
        /* eslint-disable-next-line unicorn/prefer-math-trunc -- |0 keeps 32-bit WRAP semantics Math.trunc lacks */
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

export { FAMS, ORDER, famChips, simVal, mcHold };
