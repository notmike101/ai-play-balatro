// play.mjs — score prediction, calibration, subset evaluation, discard heuristics (pure, no link).
import { evalHand, combos, rv, CHIP, BASE_IDX, SUITS } from './eval.mjs';
import { jokerFactor } from './knowledge.mjs';

/**
 * Return base chips, mult and level for a family from the in-game hands table.
 *
 * @param {object[]} handsTable - hands table rows (may be empty)
 * @param {string} fam - hand family name
 * @returns {object} chips, mult, level and name for the family
 */
function famBase(handsTable, fam) {
    const row = (handsTable || []).find((h) => h.name === fam);

    if (row) {
        return { chips: row.chips, mult: row.mult, level: row.level ?? 1, name: row.name };
    }

    return { chips: BASE_IDX[fam]?.[0] ?? 10, mult: BASE_IDX[fam]?.[1] ?? 1, level: 1, name: fam };
}

const FIB_RANKS = new Set(['Ace', 'A', '2', '3', '5', '8']);
const FACE_RANKS = new Set(['Jack', 'Queen', 'King', 'J', 'Q', 'K']);

/**
 * Modeled contribution of state-dependent jokers, constants from game configs:
 * Mystic +15 mult when discards==0 (per copy), Fibonacci +8 per scoring A/2/3/5/8 (per copy),
 * Supernova +mult per plays of this family INCLUDING current play (counter increments pre-score),
 * Ancient x1.5^copies per same-suit card, expectation over the single drawn suit. Ramen NOT modeled:
 * persistent x_mult minus .01 per discarded card run-wide (destroyed at <=1, no per-blind reset) = known residual up to x2.
 *
 * @param {string} fam - hand family
 * @param {object[]} scoring - cards that will score
 * @param {{jk?: Map<string, number>, dl?: number|null, playedOf?: (f: string) => number}} [ctx] - decision state
 * @returns {{flat: number, xm: number}} additive mult and xmult factor
 */
function knownLayer(fam, scoring, ctx) {
    const jk = ctx && ctx.jk;

    if (!jk) {
        return { flat: 0, xm: 1 };
    }

    /**
     * Count copies of a joker in the current lineup.
     *
     * @param {string} name - joker display name
     * @returns {number} copies owned (Showman duplicates included)
     */
    const n = (name) => jk.get(name) || 0;
    let flat = 0;
    let xm = 1;
    let unc = false;

    if (ctx.dl === 0) {
        flat += 15 * n('Mystic Summit');
    }

    flat += 8 * n('Fibonacci') * scoring.filter((c) => FIB_RANKS.has(c.rank)).length;
    flat += n('Supernova') * ((ctx.playedOf ? ctx.playedOf(fam) : 0) + 1);

    if (scoring.some((c) => FACE_RANKS.has(c.rank))) {
        xm *= 2 ** n('Photograph');
    }

    const anc = n('Ancient Joker');

    if (anc > 0) {
        const bySuit = {};

        for (const c of scoring) {
            bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
        }

        let acc = 0;

        for (const s of SUITS) {
            acc += 1.5 ** (anc * (bySuit[s] || 0));
        }

        xm *= acc / 4;
        /* the selected suit is fixed+random+unobserved: any Ancient play is a 1-of-4 lottery,
           a single-suit hand pays only on match (EV stays (1.5^n+3)/4) - never calibrate on one draw */
        unc = true;
    }

    /* observable accumulated joker state: family-locked +mult (Mad-class) and suit-locked
       +mult-per-scoring-card (Wrathful-class) are exact from j.values; x_mult NOT applied
       generically - condition-locked xmult jokers (Duo/Trio/Family) store their config there */
    for (const vals of ((ctx && ctx.jv) || new Map()).values()) {
        for (const v of vals) {
            if (v.type && v.t_mult && v.type === fam) {
                flat += v.t_mult;
            }

            if (v.extra && v.extra.suit && v.extra.s_mult) {
                flat += v.extra.s_mult * scoring.filter((c) => c.suit === v.extra.suit).length;
            }
        }
    }

    return { flat, xm, unc };
}

/**
 * Build prediction context from an observation (joker name->copies incl. Showman duplicates,
 * discards left, per-family play counts).
 *
 * @param {object} obs - current observation
 * @returns {{jk: Map<string, number>, dl: number|null, playedOf: (f: string) => number}} decision state
 */
const ctxOf = (obs) => {
    const jk = new Map();
    const jv = new Map();

    for (const j of obs.jokers || []) {
        jk.set(j.name, (jk.get(j.name) || 0) + 1);

        if (j.values) {
            if (!jv.has(j.name)) {
                jv.set(j.name, []);
            }

            jv.get(j.name).push(j.values);
        }
    }

    return {
        jk,
        jv,
        dl: obs.run?.discards_left ?? null,
        /**
         * Recorded plays of a family from the hands table.
         *
         * @param {string} f - hand family name
         * @returns {number} times played this run
         */
        playedOf: (f) => (obs.hands || []).find((h) => h.name === f)?.played ?? 0,
    };
};

/**
 * Predict the score of playing a family with the given scoring cards.
 *
 * @param {object[]} handsTable - hands table rows (may be empty)
 * @param {string} fam - hand family name
 * @param {object[]} scoring - cards that will score
 * @param {{jk?: Map<string, number>, dl?: number|null, playedOf?: (f: string) => number}} [ctx] - decision state
 * @returns {object} chips, mult, rounded score and unc = unresolved shared-suit lottery
 */
function predict(handsTable, fam, scoring, ctx) {
    const b = famBase(handsTable, fam);
    const chips = b.chips + scoring.reduce((s, c) => s + CHIP(rv(c)), 0);
    const k = knownLayer(fam, scoring, ctx);
    const mult = (b.mult + k.flat) * (jokerFactor[fam] ?? 1) * k.xm;

    return { chips, mult, score: Math.round(chips * mult), unc: k.unc === true };
}

/**
 * Fold one observed play into the per-family RESIDUAL joker multiplier EMA: the modeled
 * stateful layer is divided out, jokerFactor learns only what it fails to explain.
 *
 * @param {string} fam - hand family that was played
 * @param {object[]} scoring - cards that scored
 * @param {number} baseChips - table base chips used for the play
 * @param {number} baseMult - table base mult used for the play
 * @param {number} delta - observed score of the play
 * @param {{jk?: Map<string, number>, dl?: number|null, playedOf?: (f: string) => number}} [ctx] - decision state at play time
 */
function calibrate(fam, scoring, baseChips, baseMult, delta, ctx) {
    const k = knownLayer(fam, scoring, ctx);
    const exp = (baseChips + scoring.reduce((s, c) => s + CHIP(rv(c)), 0)) * (baseMult + k.flat) * k.xm;

    if (k.unc) {
        return;
    }

    if (exp > 0 && delta > 0) {
        const f = Math.min(600, Math.max(0.05, delta / exp));

        jokerFactor[fam] = jokerFactor[fam] ? jokerFactor[fam] * 0.5 + f * 0.5 : f;
    }
}

/**
 * Normalize face-down cards (The Mark/House) whose obs rank is null: rv 0 makes a fake
 * "Pair" score pred 20, so give each a distinct middling rank+suit as an EV approximation.
 *
 * @param {object[]} cards - hand cards from the observation
 * @returns {object[]} copy with face-down cards replaced by EV stand-ins
 */
function normalizeHand(cards) {
    const R = [8, 9, 10, 12, 14];
    let k = 0;

    return cards.map((c) => (c.rank === null || c.rank === undefined || c.rank === '') ? { ...c, rank: R[k % 5], suit: SUITS[k++ % 4], faceDown: true } : c);
}

/**
 * Evaluate every playable 1..5-card subset of the hand.
 *
 * @param {object[]} handCards - hand cards from the observation
 * @param {object[]} handsTable - hands table rows (may be empty)
 * @param {object} [bias] - optional family multiplier map from run strategy
 * @param {object} [ctx] - decision state from ctxOf for stateful joker modeling
 * @returns {object[]} subset evaluations with pred scores, best first
 */
function allSubsetEvals(handCards, handsTable, bias, ctx) {
    const playable = normalizeHand(handCards).filter((c) => !c.debuffed && (c.actions || []).includes('select'));
    const out = [];

    for (let k = 1; k <= Math.min(5, playable.length); k++) {
        for (const cs of combos(playable, k)) {
            const e = evalHand(cs);
            const p = predict(handsTable, e.fam, e.scoring, ctx).score;

            out.push({
                cards: cs, ...e, pred: p, util: Math.round(p * ((bias && bias[e.fam]) || 1)),
            });
        }
    }

    /* pick by strategy-WEIGHTED utility (util); pred stays unbiased predicted chips for banking/pacing.
       near-ties on utility: play FEWEST cards (kickers score 0; fewer cards hit by debuff bosses) */
    out.sort((a, b) => b.util - a.util || a.cards.length - b.cards.length);

    return out;
}

// ---------- discard keep heuristic ----------
/**
 * Score a draw/hold candidate: hand-family value first, then rank chips.
 *
 * @param {object[]} cs - intended scoring/hold 1..5 cards
 * @returns {number} heuristic draw value
 */
function drawScore(cs) {
    const e = evalHand(cs);
    const s = { 'Straight Flush': 5e6, 'Four of a Kind': 4e5, 'Full House': 3.5e5, Flush: 3e5, Straight: 2e5, 'Three of a Kind': 1.5e5, 'Two Pair': 4e4, Pair: 1e4, 'High Card': 0 }[e.fam] || 0;

    return s + e.scoring.reduce((t, c) => t + CHIP(rv(c)), 0);
}

/**
 * Pick up to 5 cards to discard.
 *
 * @param {object[]} handCards - hand cards from the observation
 * @param {object} bestPlay - best planned play (currently unused)
 * @param {string | null} lock - family locked by Eye/Mouth boss, or null
 * @returns {object[]} cards to discard
 */
function chooseDiscard(handCards, bestPlay, lock) {
    handCards = normalizeHand(handCards);
    let cards = handCards.filter((c) => !c.debuffed && (c.actions || []).includes('select'));

    if (!cards.length) {
        cards = handCards.filter((c) => (c.actions || []).includes('select'));
    }

    if (lock) {
        /**
         * Sort key grouping cards by the locked-family target.
         *
         * @param {object} c - card observation
         * @returns {string | number} suit when Flush is locked, otherwise rank
         */
        const keyOf = (c) => lock === 'Flush' ? c.suit : c.rank;
        const cnt = {};

        for (const c of cards) {
            cnt[keyOf(c)] = (cnt[keyOf(c)] || 0) + 1;
        }

        const keep = [...cards].sort((a, b) => cnt[keyOf(b)] - cnt[keyOf(a)] || rv(b) - rv(a)).slice(0, 5);
        const ki = new Set(keep.map((c) => c.id));
        const dl = cards.filter((c) => !ki.has(c.id));

        if (dl.length) {
            return dl.slice(0, 5);
        }
    }

    // hold candidates: best 5-card draw base by drawScore
    const five = handCards.length >= 5 ? combos(handCards, 5) : [handCards];
    let best = null;

    for (const f of five) {
        const s = drawScore(f);

        if (!best || s > best.s) {
            best = { s, f };
        }
    }

    const keepIds = new Set(best.f.map((c) => c.id));
    const disc = cards.filter((c) => !keepIds.has(c.id));

    // nothing to cut: dump single lowest junk that isn't in best pair
    if (disc.length === 0) {
        const worst = [...cards].sort((a, b) => rv(a) - rv(b))[0];

        return [worst];
    }

    return disc.slice(0, 5);
}

export { famBase, predict, calibrate, normalizeHand, allSubsetEvals, drawScore, chooseDiscard, ctxOf, knownLayer };
