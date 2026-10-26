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
const ODD_RANKS = new Set(['Ace', 'A', '3', '5', '7', '9']);
const EVEN_RANKS = new Set(['2', '4', '6', '8', '10']);
const TEN_OR_FOUR = new Set(['10', 'T', '4']);

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
        return { flat: 0, cflat: 0, xm: 1, unc: false };
    }

    /**
     * Count copies of a joker in the current lineup.
     *
     * @param {string} name - joker display name
     * @returns {number} copies owned (Showman duplicates included)
     */
    const n = (name) => jk.get(name) || 0;
    let flat = 0;
    let cflat = 0;
    let xm = 1;
    let unc = false;

    if (ctx.dl === 0) {
        flat += 15 * n('Mystic Summit');
    }

    flat += 8 * n('Fibonacci') * scoring.filter((c) => !c.debuffed && FIB_RANKS.has(c.rank)).length;
    flat += n('Supernova') * ((ctx.playedOf ? ctx.playedOf(fam) : 0) + 1);

    if (scoring.some((c) => !c.debuffed && FACE_RANKS.has(c.rank))) {
        xm *= 2 ** n('Photograph');
    }

    const anc = n('Ancient Joker');

    if (anc > 0) {
        const bySuit = {};

        for (const c of scoring) {
            if (!c.debuffed) {
                bySuit[c.suit] = (bySuit[c.suit] || 0) + 1;
            }
        }

        /* each Ancient copy picked its suit independently (Showman pairs too); a copy's suit is
           readable from values.extra.suit (Wrathful-shape state) - known copies are exact,
           unknown ones are a 1-in-4 lottery whose single draw must never train the residual */
        const ancSuits = ((ctx.jv && ctx.jv.get('Ancient Joker')) || []).map((v) => (v.extra && v.extra.suit) || null).filter(Boolean);
        let ev = 1;

        for (let i = 0; i < anc; i++) {
            const known = ancSuits[i];

            if (known) {
                ev *= 1.5 ** (bySuit[known] || 0);
            } else {
                let acc = 0;

                for (const s of SUITS) {
                    acc += 1.5 ** (bySuit[s] || 0);
                }

                ev *= acc / 4;
                unc = true;
            }
        }

        xm *= ev;
    }

    /* name-gated observable state (units differ per joker):
       Scary Face extra = accumulated Chips per scoring face card (J/Q/K);
       Abstract Joker extra = Mult UNIT per owned Joker copy (incl. itself);
       Green Joker scores mult + hand_add: values.mult is the pre-play store and
       extra.hand_add is the increment applied during the current hand's scoring;
       Odd Todd/Even Steven/Banner = stored bonus per odd-rank/even-rank card/per discard left;
       Scholar = stored chips+mult per scoring Ace; Vampire = stored x_mult + per-card step
       times enhanced cards entering the pending play */
    let jTot = 0;

    for (const cnt of jk.values()) {
        jTot += cnt;
    }

    for (const [name, vals] of ((ctx.jv) || new Map()).entries()) {
        for (const v of vals) {
            if (v.type && v.t_mult && v.type === fam) {
                flat += v.t_mult;
            }

            if (v.extra && v.extra.suit && v.extra.s_mult) {
                flat += v.extra.s_mult * scoring.filter((c) => !c.debuffed && c.suit === v.extra.suit).length;
            }

            /* Walkie Talkie: +10 Chips +4 Mult per scoring 10 or 4 (conditional trigger,
               not per-card generic — shape-sharing jokers each need their own condition) */
            if (name === 'Walkie Talkie' && v.extra && typeof v.extra.chips === 'number' && typeof v.extra.mult === 'number') {
                const n = scoring.filter((c) => !c.debuffed && TEN_OR_FOUR.has(c.rank)).length;

                cflat += v.extra.chips * n;
                flat += v.extra.mult * n;
            }

            if (name === 'Joker Stencil' && typeof v.x_mult === 'number' && v.x_mult > 1) {
                xm *= v.x_mult;
            }

            /* Misprint: EV max/2 for hand SELECTION, but the realized roll is random per play —
               mark unc so calibrate never trains jokerFactor from a single dice result */
            if (name === 'Misprint' && v.extra && typeof v.extra.max === 'number') {
                flat += v.extra.max / 2;
                unc = true;
            }

            if (name === 'Spare Trousers' && typeof v.mult === 'number') {
                flat += v.mult + (typeof v.extra === 'number' && (fam === 'Two Pair' || fam === 'Full House') ? v.extra : 0);
            }

            if (name === 'Scary Face' && typeof v.extra === 'number') {
                cflat += v.extra * scoring.filter((c) => !c.debuffed && FACE_RANKS.has(c.rank)).length;
            }

            /* Smiley Face: +Mult (stored in extra) per LIVE scoring face card;
               Matador is economy-only ($ per boss-ability trigger) — never scores */
            if (name === 'Smiley Face' && typeof v.extra === 'number') {
                flat += v.extra * scoring.filter((c) => !c.debuffed && FACE_RANKS.has(c.rank)).length;
            }

            /* Obelisk stores growth as live XMult; plain Joker is static mult.
               Blue Joker (+2 Chips per card still remaining in deck) intentionally NOT
               modeled: deck count is not in the observation, so the state is unavailable */
            if (name === 'Obelisk' && typeof v.x_mult === 'number' && v.x_mult > 1) {
                xm *= v.x_mult;
            }

            if (name === 'Joker' && typeof v.mult === 'number') {
                flat += v.mult;
            }

            /* Constellation: like Obelisk, growth lives in the x_mult store (per planet used).
               Ride the Bus (+1 Mult per qualifying hand; growth lands in values.mult, which
               early samples never populated) and Oops! All 6s (probabilistic retrigger of
               listed probabilities — run-wide variance, not per-score uncertainty) are both
               intentionally unmodeled until their store shapes are observed growing */
            if (name === 'Constellation' && typeof v.x_mult === 'number' && v.x_mult > 1) {
                xm *= v.x_mult;
            }

            if (name === 'Abstract Joker' && typeof v.extra === 'number') {
                flat += v.extra * jTot;
            }

            if (name === 'Green Joker' && typeof v.mult === 'number') {
                flat += v.mult + ((v.extra && v.extra.hand_add) || 0);
            }

            if (name === 'Odd Todd' && typeof v.extra === 'number') {
                cflat += v.extra * scoring.filter((c) => !c.debuffed && ODD_RANKS.has(c.rank)).length;
            }

            if (name === 'Even Steven' && typeof v.extra === 'number') {
                flat += v.extra * scoring.filter((c) => !c.debuffed && EVEN_RANKS.has(c.rank)).length;
            }

            if (name === 'Banner' && typeof v.extra === 'number') {
                cflat += v.extra * (ctx.dl ?? 0);
            }

            if (name === 'Scholar' && v.extra && typeof v.extra.chips === 'number' && typeof v.extra.mult === 'number') {
                const aces = scoring.filter((c) => !c.debuffed && (c.rank === 'Ace' || c.rank === 'A')).length;

                cflat += v.extra.chips * aces;
                flat += v.extra.mult * aces;
            }

            if (name === 'Vampire' && typeof v.extra === 'number') {
                xm *= (v.x_mult ?? 1) + v.extra * scoring.filter((c) => !c.debuffed && ((c.enhancements || []).some((e) => e && e !== 'base') || (c.key && c.key !== 'c_base') || (c.values && c.values.type))).length;
            }

            if (name === 'Popcorn' && typeof v.mult === 'number') {
                flat += v.mult;
            }

            if (name === 'Ice Cream' && v.extra && typeof v.extra.chips === 'number') {
                cflat += v.extra.chips;
            }

            if (name === 'Gros Michel' && v.extra && typeof v.extra.mult === 'number') {
                flat += v.extra.mult;
            }

            if (name === 'Ramen' && typeof v.x_mult === 'number' && v.x_mult > 0) {
                xm *= v.x_mult;
            }

            /* Loyalty Card: Xmult every Nth play; loyalty_remaining is the live counter
               (observed shape: extra{Xmult:4,every:5}, loyalty_remaining) — extra is
               absent while cycling; only the observed countdown to a boost row marks unc */
        }
    }

    return { flat, cflat, xm, unc };
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
    const k = knownLayer(fam, scoring, ctx);
    const chips = b.chips + (k.cflat || 0) + scoring.reduce((s, c) => s + (c.debuffed ? 0 : CHIP(rv(c))), 0);
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
    const exp = (baseChips + (k.cflat || 0) + scoring.reduce((s, c) => s + (c.debuffed ? 0 : CHIP(rv(c))), 0)) * (baseMult + k.flat) * k.xm;

    /* face-down scoring (The House/Mark): fake stand-in ranks must not train jokerFactor */
    const hid = scoring.filter((c) => c.faceDown || c.rank === null || c.rank === undefined || c.rank === '').length;

    if (k.unc || hid >= 2) {
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
    // debuffed cards stay playable: they classify the hand shape but add no chips/triggers
    const playable = normalizeHand(handCards).filter((c) => (c.actions || []).includes('select'));
    const out = [];

    for (let k = 1; k <= Math.min(5, playable.length); k++) {
        for (const cs of combos(playable, k)) {
            const e = evalHand(cs);
            const p = predict(handsTable, e.fam, e.scoring, ctx).score;
            /* >=2 face-down cards: real identities unresolvable (House/Mark) — EV capped at 0.55;
               a lone unknown may still be the pair partner, so it keeps full credit */
            const hid = cs.filter((c) => c.faceDown).length;
            const guard = hid >= 2 ? 0.55 : 1;

            out.push({
                cards: cs, ...e, pred: p, util: Math.round(p * guard * ((bias && bias[e.fam]) || 1)),
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
    const selectable = handCards.filter((c) => (c.actions || []).includes('select'));
    const live = selectable.filter((c) => !c.debuffed);
    const cards = live.length ? live : selectable;

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

    // keep base from live cards while at least 5 exist; dead cards only hold shape when scarce
    const pool = live.length >= 5 ? live : selectable;
    const five = pool.length >= 5 ? combos(pool, 5) : [pool];
    let best = null;

    for (const f of five) {
        const s = drawScore(f);

        if (!best || s > best.s) {
            best = { s, f };
        }
    }

    const keepIds = new Set(best.f.map((c) => c.id));
    const disc = selectable.filter((c) => !keepIds.has(c.id)).sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || rv(a) - rv(b));

    // nothing to cut: dump single lowest junk that isn't in best pair
    if (disc.length === 0) {
        const worst = [...selectable].sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || rv(a) - rv(b))[0];

        return [worst];
    }

    return disc.slice(0, 5);
}

export { famBase, predict, calibrate, normalizeHand, allSubsetEvals, drawScore, chooseDiscard, ctxOf, knownLayer };
