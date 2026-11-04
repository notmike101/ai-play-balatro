/* routes.mjs — multi-hand CLEAR-P solver (v1 shadow, 11-04): the subset scorer answers
   "what scores best NOW"; this answers "which decision leaves the best chance of clearing
   the blind" by Monte-Carlo rolling the remaining hands from unseen deck composition.
   ponytail: static joker layer (no mid-blind value growth), no boss filters (Psychic/Eye/
   Mouth), drawn cards scored as base cards (enhance/seal lotteries ignored) - all
   conservative for the discard branch; upgrades when the shadow census disagrees. */

import { allSubsetEvals, ctxOf } from './play.mjs';

const RV = { A: 14, Ace: 14, K: 13, King: 13, Q: 12, Queen: 12, J: 11, Jack: 11 };
const N_SIM = 25;

/**
 * Chip-ish value of a card for the discard heuristic (rough, discard order only).
 *
 * @param {object} c - card
 * @returns {number} rank value
 */
function cv(c) {
    const n = Number(c && c.rank);

    return Number.isNaN(n) ? (RV[c && c.rank] ?? 0) : n;
}

/**
 * Build the unseen draw pool from the deck composition manifest, minus cards
 * currently visible in hand (approximate seen set - never overprices draws much).
 *
 * @param {object} obs - hand-phase observation
 * @returns {object[]|null} pool of {rank, suit} or null when no manifest
 */
function drawPool(obs) {
    const comp = obs.deck && obs.deck.composition;

    if (!Array.isArray(comp) || !comp.length) {
        return null;
    }

    const vis = new Map();

    for (const c of obs.hand || []) {
        const k = `${c.rank}|${c.suit}`;

        vis.set(k, (vis.get(k) || 0) + 1);
    }

    const pool = [];

    for (const row of comp) {
        const r = row[0];
        const s = row[1];
        const avail = Math.max(0, (typeof row[5] === 'number' ? row[5] : 1) - (vis.get(`${r}|${s}`) || 0));

        for (let i = 0; i < avail; i++) {
            pool.push({ rank: r, suit: s });
        }
    }

    return pool.length >= 10 ? pool : null;
}

/**
 * Roll one simulated continuation to the end of the blind.
 *
 * @param {object[]} hand - current hand cards (mutated copy)
 * @param {object[]} pool - mutable draw pool
 * @param {number} rem - chips still needed
 * @param {number} hl - hands left (after the branch decision)
 * @param {number} dl - discards left
 * @param {object[]} handsTable - obs.hands (levels)
 * @param {object} bias - live family bias
 * @param {object} ctx - prediction context
 * @returns {number} 1 cleared, 0 ran out of hands
 */
function roll(hand, pool, rem, hl, dl, handsTable, bias, ctx) {
    for (let step = 0; step < 8; step++) {
        if (rem <= 0) {
            return 1;
        }

        if (hl <= 0) {
            return 0;
        }

        const ev = allSubsetEvals(hand, handsTable, bias, ctx);
        const best = ev[0];

        if (!best || (best.pred < rem / hl && dl > 0)) {
            /* discard: dump the lowest-value cards outside the best subset */
            const keep = new Set(best ? best.cards.map((c) => c.id ?? c) : []);
            const junk = hand.filter((c) => !keep.has(c.id ?? c)).sort((a, b) => cv(a) - cv(b)).slice(0, 5);
            const gone = new Set(junk.map((c) => c.id ?? c));

            hand = hand.filter((c) => !gone.has(c.id ?? c));
            dl--;
        } else {
            rem -= best.pred;
            const gone = new Set(best.cards.map((c) => c.id ?? c));

            hand = hand.filter((c) => !gone.has(c.id ?? c));
            hl--;
        }

        while (hand.length < 8 && pool.length) {
            const i = Math.floor(Math.random() * pool.length);

            hand.push(...pool.splice(i, 1));
        }
    }

    return rem <= 0 ? 1 : 0;
}

/**
 * Clear-probability of both branches from the CURRENT pre-play hand:
 * play-best-now vs discard-worst-now. Pure read on obs; never mutates game state.
 *
 * @param {object} obs - pre-play hand-phase observation
 * @param {{pred: (number|null), rem: (number|null)}} t - the decision just taken (for telemetry context only)
 * @param {object} bias - live family bias
 * @returns {(object|null)} {pNow, pDisc, rem, hl, dl} or null when unscoreable
 */
function routeEV(obs, t, bias) {
    const target = obs.run?.blind?.target ?? 0;
    const hl = obs.run?.hands_left ?? null;
    const dl = obs.run?.discards_left ?? null;
    const scored = obs.run?.chips ?? 0;

    if (!(target > 0) || !(hl >= 1) || !Number.isFinite(scored)) {
        return null;
    }

    const pool0 = drawPool(obs);
    const hand0 = (obs.hand || []).filter((c) => c.rank !== null && c.rank !== undefined && c.rank !== '');

    if (!pool0 || hand0.length < 5) {
        return null;
    }

    const ctx = ctxOf(obs);
    const ev = allSubsetEvals(hand0, obs.hands, bias, ctx);
    const best = ev[0];
    const rem0 = Math.max(0, target - scored);

    if (!best) {
        return null;
    }

    let now = 0;
    let disc = 0;

    for (let i = 0; i < N_SIM; i++) {
        now += roll(hand0.slice(), pool0.slice(), rem0 - best.pred, hl - 1, dl, obs.hands, bias, ctx);

        const keep = new Set(best.cards.map((c) => c.id ?? c));
        const junk = hand0.filter((c) => !keep.has(c.id ?? c)).sort((a, b) => cv(a) - cv(b)).slice(0, 5);
        const jk = new Set(junk.map((c) => c.id ?? c));
        const h2 = hand0.filter((c) => !jk.has(c.id ?? c)).slice();

        if (dl > 0 && h2.length >= 3) {
            disc += roll(h2, pool0.slice(), rem0, hl, dl - 1, obs.hands, bias, ctx);
        } else {
            disc += roll(hand0.slice(), pool0.slice(), rem0 - best.pred, hl - 1, dl, obs.hands, bias, ctx);
        }
    }

    return { pNow: +(now / N_SIM).toFixed(2), pDisc: +(disc / N_SIM).toFixed(2), rem: rem0, hl, dl, tgt: !!t };
}

export { routeEV };
