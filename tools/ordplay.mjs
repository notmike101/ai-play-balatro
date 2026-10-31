/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
/* Ordered-chain replay: validate whether joker SLOT ORDER + card order + per-step
 * floor explain the aggregate model's bias (actual/pred p50=0.84 census).
 * Joins decide(play) rows to turn-row hand diffs to recover the played set;
 * replays score with (a) aggregate math and (b) ordered simulation
 * (cards L->R, then jokers L->R, floor per x-operation).
 * Prints p10/p50/p90 + tight-band fit for both. Read-only analysis tool. */
import { readFileSync } from 'node:fs';

const L = readFileSync(new URL('../out/log.jsonl', import.meta.url), 'utf8').trim().split('\n');
const rows = L.map((s) => {
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}).filter((j) => j && j.ts && j.rid);
const byRid = {};

for (const j of rows) {
    (byRid[j.rid] ??= []).push(j);
}

const hsLvl = {};

for (const j of rows) {
    if (j.e === 'handstab') {
        (hsLvl[j.rid] ??= []).push(j);
    }
}

const RANKV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, Jack: 11, Queen: 12, King: 13, Ace: 14, J: 11, Q: 12, K: 13, A: 14 };

/**
 * Numeric rank value.
 *
 * @param {string | number} r - rank as seen in turn rows
 * @returns {number} value or 0
 */
const rv = (r) => (typeof r === 'number' ? r : (RANKV[r] ?? 0));

/**
 * Chip value of a numeric rank.
 *
 * @param {number} v - rank value
 * @returns {number} chips
 */
const CHIP = (v) => {
    if (v <= 10) {
        return v;
    }

    return v === 14 ? 11 : 10;
};

const BASE = { 'High Card': [5, 1], Pair: [10, 2], 'Two Pair': [20, 2], 'Three of a Kind': [30, 3], Straight: [30, 4], Flush: [35, 4], 'Full House': [40, 4], 'Four of a Kind': [60, 7], 'Straight Flush': [100, 8] };

/**
 * Parse a turn-row card tuple.
 *
 * @param {Array} t - tuple [id, rank, suit, actions, debuff, enhString]
 * @returns {object} card object
 */
function mkCard(t) {
    const enh = (t[5] || '').split('|').filter(Boolean);

    return { id: t[0], rank: t[1], suit: t[2], debuff: t[4] === 'D', enh, v: rv(t[1]) };
}

/**
 * Scoring subset for standard-9 families.
 *
 * @param {object[]} cards - played cards in hand order
 * @returns {{fam: string, sc: object[]}} family and scoring cards
 */
function scoringOf(cards) {
    const cnt = {};

    for (const c of cards) {
        cnt[c.v] = (cnt[c.v] || 0) + 1;
    }

    const groups = Object.entries(cnt).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const suits = new Set(cards.map((c) => c.suit));
    const vals = [...new Set(cards.map((c) => c.v))].sort((a, b) => a - b);
    const flush = cards.length === 5 && suits.size === 1;
    let straightHigh = 0;

    if (vals.length === 5) {
        if (vals[4] - vals[0] === 4) {
            straightHigh = vals[4];
        }

        if (vals.join(',') === '2,3,4,5,14') {
            straightHigh = 5;
        }
    }

    const g0 = groups[0][1];
    const g1 = groups[1] ? groups[1][1] : 0;

    if (flush && straightHigh) {
        return { fam: 'Straight Flush', sc: cards };
    }

    if (g0 === 4) {
        return { fam: 'Four of a Kind', sc: cards.filter((c) => c.v === +groups[0][0]) };
    }

    if (g0 === 3 && g1 === 2) {
        return { fam: 'Full House', sc: cards };
    }

    if (flush) {
        return { fam: 'Flush', sc: cards };
    }

    if (straightHigh) {
        return { fam: 'Straight', sc: cards };
    }

    if (g0 === 3) {
        return { fam: 'Three of a Kind', sc: cards.filter((c) => c.v === +groups[0][0]) };
    }

    if (g0 === 2 && g1 === 2) {
        return { fam: 'Two Pair', sc: cards.filter((c) => c.v === +groups[0][0] || c.v === +groups[1][0]) };
    }

    if (g0 === 2) {
        return { fam: 'Pair', sc: cards.filter((c) => c.v === +groups[0][0]) };
    }

    let hi = cards[0];

    for (const c of cards) {
        if (c.v > hi.v) {
            hi = c;
        }
    }

    return { fam: 'High Card', sc: [hi] };
}

/**
 * Enhancement/seal deltas (vanilla constants; build table pending validation).
 *
 * @param {object[]} cs - scoring cards
 * @returns {{chips: number, mult: number, xm: number}} additive and xmult parts
 */
function enhOf(cs) {
    let chips = 0;
    let mult = 0;
    let xm = 1;

    for (const c of cs) {
        for (const e of c.enh) {
            if (/bonus/.test(e)) {
                chips += 15;
            }

            if (/mult/.test(e)) {
                mult += 4;
            }

            if (/glass/.test(e)) {
                xm *= 2;
            }
        }

        for (const s of c.enh.filter((x) => /^S:/.test(x))) {
            if (s.includes('Red')) {
                chips += 50;
            }
        }
    }

    return { chips, mult, xm };
}

/**
 * Joker operations extracted from observed values, IN SLOT ORDER.
 *
 * @param {Array[]} jk - turn-row jokers array (slot order)
 * @param {object[]} sc - scoring cards (for face conditions)
 * @returns {object[]} ops with kind c|m|x|unk
 */
function jokerOps(jk, sc, fam) {
    const ops = [];

    for (const [name, , extra, v] of jk) {
        if (!v) {
            ops.push({ kind: 'unk', name });
            continue;
        }

        const tMult = typeof v.t_mult === 'number' ? v.t_mult : 0;
        const tChips = typeof v.t_chips === 'number' ? v.t_chips : 0;
        const mult = typeof v.mult === 'number' ? v.mult : 0;
        const xmult = typeof v.x_mult === 'number' ? v.x_mult : 1;

        /* conditional +mult/+chips jokers (Crazy/Zany/Lusty/Green...) write this play's
           increment into t_mult/t_chips tagged with the triggering hand type - counting
           them on OTHER hands caused the x0.1 overpred class */
        if (tChips && (!v.type || v.type === fam)) {
            ops.push({ kind: 'c', v: tChips, name });
        }

        if (tMult && (!v.type || v.type === fam)) {
            ops.push({ kind: 'm', v: tMult, name });
        }

        if (name === 'Green Joker') {
            ops.push({ kind: 'm', v: mult + ((v.extra && v.extra.hand_add) || 0), name });
        } else if (mult && name !== 'Green Joker') {
            ops.push({ kind: 'm', v: mult, name });
        }

        if (xmult !== 1) {
            ops.push({ kind: 'x', v: xmult, name });
        }

        if (name === 'Photograph' && sc.some((c) => !c.debuff && c.v >= 11 && c.v <= 13)) {
            ops.push({ kind: 'x', v: 2, name });
        }

        if (name === 'Ice Cream' && v.extra && v.extra.chips) {
            ops.push({ kind: 'c', v: v.extra.chips, name });
        }

        /* Loyalty boost hand = observation showing remaining 0 (measured boundary) */
        if (name === 'Loyalty Card' && v.extra && v.extra.Xmult > 1 && v.loyalty_remaining === 0) {
            ops.push({ kind: 'x', v: v.extra.Xmult, name });
        }

        if (typeof extra === 'number' && extra && !tMult && !tChips && !['Green Joker', 'Ice Cream'].includes(name)) {
            ops.push({ kind: 'unk', name });
        }
    }

    return ops;
}

/**
 * Ordered simulation: cards L->R accrue chips, then jokers trigger L->R with
 * per-operation semantics; x-ops floor the running score.
 *
 * @param {number[]} base - [chips, mult] family base
 * @param {object[]} sc - scoring cards
 * @param {Array[]} jk - slot-ordered joker list from the turn row
 * @returns {number} simulated score
 */
function simOrdered(base, sc, jk, re = 1, fam = '') {
    const e = enhOf(sc);
    let chips = base[0];
    const mult = base[1] + e.mult;

    for (const c of sc) {
        if (!c.debuff) {
            chips += re * CHIP(c.v);
        }
    }

    /* ponytail: Mime retrigger of enhancement/seal effects not modeled, only rank chips */
    let score = chips * mult * e.xm;

    for (const op of jokerOps(jk, sc, fam)) {
        if (op.cond && !op.cond()) {
            continue;
        }

        switch (op.kind) {
            case 'x': {
                score = Math.floor(score * op.v);

                break;
            }
            case 'm': {
                score += chips * op.v;

                break;
            }
            case 'c': {
                score += op.v * mult;

                break;
            }
        // No default
        }
    }

    return score;
}

/**
 * Aggregate simulation (driver-style): all adds then all xs, one floor at the end.
 *
 * @param {number[]} base - [chips, mult] family base
 * @param {object[]} sc - scoring cards
 * @param {Array[]} jk - joker list
 * @returns {number} simulated score
 */
function simAgg(base, sc, jk, re = 1, fam = '') {
    const e = enhOf(sc);
    let chips = base[0];
    let mult = base[1] + e.mult;

    for (const c of sc) {
        if (!c.debuff) {
            chips += re * CHIP(c.v);
        }
    }

    let xm = 1;

    for (const op of jokerOps(jk, sc, fam)) {
        if (op.cond && !op.cond()) {
            continue;
        }

        switch (op.kind) {
            case 'x': {
                xm *= op.v;

                break;
            }
            case 'm': {
                mult += op.v;

                break;
            }
            case 'c': {
                chips += op.v;

                break;
            }
        // No default
        }
    }

    return chips * mult * xm;
}

/**
 * ids are SLOT positions reused on refill -> multiset diff on content.
 * Scans every following turn row in-window: during the scoring animation the
 * table still shows played cards, so the first post-play row usually diffs exact.
 *
 * @param {object[]} pre - pre-play hand cards (ordered)
 * @param {object[]} rs - rid event rows sorted by ts
 * @param {number} k - index of the decide row in rs
 * @param {object} d - decide row
 * @returns {object[] | null} played cards in hand order, or null when unrecoverable
 */
function findPlayed(pre, rs, k, d) {
    if (d.cids) {
        const byId = {};

        for (const c of pre) {
            byId[c.id] = c;
        }

        const cards = d.cids.split('.').map((x) => byId[+x]);

        return cards.every(Boolean) ? cards : null;
    }

    for (let m = k + 1; m < rs.length; m++) {
        const nx = rs[m];

        if (nx.e === 'turn' && nx.ts - d.ts > 1_500 && nx.ts - d.ts < 60_000) {
            const postCnt = {};

            for (const t of nx.hand) {
                const k2 = `${t[1]}|${t[2]}|${t[5] || ''}`;

                postCnt[k2] = (postCnt[k2] || 0) + 1;
            }

            const diff = [];

            for (const c of pre) {
                const k2 = `${c.rank}|${c.suit}|${c.enh.join(',')}`;

                if (postCnt[k2] > 0) {
                    postCnt[k2]--;
                } else {
                    diff.push(c);
                }
            }

            let want = -1;

            if (typeof d.n === 'number') {
                want = d.n;
            } else if (d.cids) {
                want = d.cids.split('.').length;
            }

            if (diff.length === want && diff.length <= 5) {
                return diff;
            }
        }

        if (['blind', 'shopdump'].includes(nx.e)) {
            break;
        }
    }

    return null;
}

const ratios = { agg: [], ord: [], pred: [] };
const predPre = [];
const predPost = [];
const byJoker = {};
const off = [];
const dbg = { dec: 0, noPre: 0, noNext: 0, badGain: 0, badPlayed: 0, famMis: 0, ok: 0 };

for (const rs0 of Object.values(byRid)) {
    const rs = rs0.sort((a, b) => a.ts - b.ts);

    for (let k = 0; k < rs.length; k++) {
        const d = rs[k];

        if (!(d.e === 'decide' && d.a === 'play' && d.pred > 0)) {
            continue;
        }

        dbg.dec++;
        let tPre = null;

        for (let m = k; m >= 0 && k - m < 4; m--) {
            if (rs[m].e === 'turn') {
                tPre = rs[m];
                break;
            }
        }

        let tNext = null;

        for (let m = k + 1; m < rs.length; m++) {
            if (rs[m].e === 'turn' && rs[m].ts - d.ts > 2_000) {
                tNext = rs[m];
                break;
            }

            if (['blind', 'shopdump'].includes(rs[m].e)) {
                break;
            }
        }

        if (!tPre) {
            dbg.noPre++;
            continue;
        }

        if (!tNext) {
            dbg.noNext++;
            continue;
        }

        const gain = tNext.chips - d.rchips;

        if (!(gain > 0)) {
            dbg.badGain++;
            continue;
        }

        const pre = tPre.hand.map(mkCard);

        const played = findPlayed(pre, rs, k, d);

        if (!played) {
            dbg.badPlayed++;
            continue;
        }

        const ev = scoringOf(played);

        if (!BASE[ev.fam] || ev.fam !== d.fam) {
            dbg.famMis++;
            continue;
        }

        dbg.ok++;
        const hs = (hsLvl[d.rid] || []).filter((h) => h.ts <= d.ts).pop();
        const hrow = hs ? hs.rows.find((r) => r[0] === ev.fam) : null;
        /* game's own table row [name, level, chips, mult, plays]; may be stale when a
           planet fired mid-ante after the once-per-ante snapshot - accepted skew */
        const base = hrow ? [hrow[2], hrow[3]] : BASE[ev.fam];
        const jkArr = tPre.jk || [];
        const names = jkArr.map((j) => j[0]);
        const scUse = names.includes('Splash') ? played : ev.sc;
        /* Mime = held-in-hand retriggers (oracle), no played-chip effect; steel held not modeled here */
        const agg = simAgg(base, scUse, jkArr, 1, ev.fam);
        const ord = simOrdered(base, scUse, jkArr, 1, ev.fam);

        if (ord > 0 && agg > 0) {
            ratios.agg.push(gain / agg);
            ratios.ord.push(gain / ord);
            ratios.pred.push(gain / d.pred);
            (d.ts > 1793332320000 ? predPost : predPre).push(gain / d.pred);
            for (const nm of new Set(names)) {
                (byJoker[nm] ??= []).push(gain / d.pred);
            }
            off.push({
                ante: d.ante,
                fam: d.fam,
                r: gain / ord,
                rp: gain / d.pred,
                jk: (tPre.jk || []).map((j) => j[0]).join('+'),
                cards: played.map((c) => `${c.rank}${(c.suit || '?')[0]}${c.enh && c.enh.length ? `/${c.enh.join('~')}` : ''}`).join(' '),
            });
        }
    }
}

console.log('dbg:', JSON.stringify(dbg));

/**
 * Quantile line for a ratio array.
 *
 * @param {number[]} a - ratios
 * @returns {string} formatted stats
 */
function q(a) {
    if (!a.length) {
        return 'n=0';
    }

    a.sort((x, y) => x - y);

    return `n=${a.length} p10=${a[Math.floor(a.length * 0.1)].toFixed(2)} p50=${a[Math.floor(a.length * 0.5)].toFixed(2)} p90=${a[Math.floor(a.length * 0.9)].toFixed(2)} inTight=${(100 * a.filter((r) => r >= 0.9 && r <= 1.1).length / a.length).toFixed(0)}%`;
}

console.log('AGG (aggregate jokers, end floor):', q(ratios.agg));
console.log('ORD (slot order, per-op, x floor) :', q(ratios.ord));
console.log('driver PRED                        :', q(ratios.pred));
console.log('  PRE-oracle-deploy:', q(predPre));
console.log('  POST-oracle-deploy:', q(predPost));

/* per-joker ground-truth accuracy: median actual/pred on plays whose board holds it
   (n>=5 shown; |log(p50)| = fix priority, board-confounded - read offenders with care) */
const jent = Object.entries(byJoker).filter(([, v]) => v.length >= 5).sort((a, b) => {
    const la = Math.abs(Math.log(a[1].slice().sort((x, y) => x - y)[Math.floor(a[1].length / 2)]));
    const lb = Math.abs(Math.log(b[1].slice().sort((x, y) => x - y)[Math.floor(b[1].length / 2)]));

    return lb - la;
});

console.log('-- per-joker gain/pred (n>=5, worst |log med| first) --');

for (const [nm, v] of jent) {
    v.sort((x, y) => x - y);
    console.log(nm.padEnd(17), `n=${String(v.length).padStart(3)} p25=${v[Math.floor(v.length * 0.25)].toFixed(2)} p50=${v[Math.floor(v.length / 2)].toFixed(2)} p75=${v[Math.floor(v.length * 0.75)].toFixed(2)}`);
}

off.sort((x, y) => Math.abs(Math.log(x.r)) - Math.abs(Math.log(y.r)));

for (const o of off.slice(-10).reverse()) {
    console.log(`x${o.r.toFixed(2)} predx${o.rp.toFixed(2)} a${o.ante} ${o.fam} | ${o.jk} | ${o.cards}`);
}
