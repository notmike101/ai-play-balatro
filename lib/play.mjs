// play.mjs — score prediction, calibration, subset evaluation, discard heuristics (pure, no link).
import { evalHand, combos, rv, CHIP, BASE_IDX, SUITS, isSteel } from './eval.mjs';
import { FAMS, mcHold } from './mc.mjs';
import { knownLayer, chVariants } from './jmodel.mjs';
import { jokerFactor, jokerSig } from './knowledge.mjs';
/* wave-3: blind-repeat counters (Card Sharp) + run-seen tracker (Blue) live in reps.mjs */
import { markSeen, unseenCopies, resetSeen, resetRoundReps, syncReps, getRoundReps, seenN } from './reps.mjs';

/**
 * Signature of the joker lineup (name:count, order-insensitive) a factor was learned under.
 *
 * @param {object} [ctx] - decision state from ctxOf
 * @returns {string} lineup signature ('' for none)
 */
const jSig = (ctx) => [...((ctx && ctx.jk) || new Map()).entries()].map(([k, v]) => `${k}:${v}`).sort().join('|');

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

// (reps/seen state island: moved verbatim to lib/reps.mjs, wave-3)

/**
 * Build prediction context from an observation (joker name->copies incl. Showman duplicates,
 * discards left, per-family play counts).
 *
 * @param {object} obs - current observation
 * @returns {{jk: Map<string, number>, dl: number|null, playedOf: (f: string) => number}} decision state
 */
const ctxOf = (obs) => {
    markSeen(obs.hand);
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
        unseen: unseenCopies(obs.deck && obs.deck.composition),
        dl: obs.run?.discards_left ?? null,
        hl: obs.run?.hands_left ?? null,
        /**
         * Boss blind name; The Flint halves table base chips and mult (build effect
         * text: "Base Chips and Mult are halved").
         *
         * @type {string}
         */
        boss: obs.run?.blind?.name || '',
        /* verbatim boss effect text (blind.effect) — face-null/other dead-joker tests */
        bossEff: Array.isArray(obs.run?.blind?.effect) ? obs.run.blind.effect.join(' ') : (obs.run?.blind?.effect || ''),
        /**
         * Recorded plays of a family from the hands table.
         *
         * @param {string} f - hand family name
         * @returns {number} times played this run
         */
        playedOf: (f) => (obs.hands || []).find((h) => h.name === f)?.played ?? 0,
        pl: { ...getRoundReps() },
        /**
         * Full pre-play hand (Baron needs held-not-played Kings).
         *
         * @type {(object[] | undefined)}
         */
        hand: obs.hand,
    };
};

/**
 * Predict the score of playing a family with the given scoring cards.
 *
 * @param {object[]} handsTable - hands table rows (may be empty)
 * @param {string} fam - hand family name
 * @param {object[]} scoring - cards that will score
 * @param {{jk?: Map<string, number>, dl?: number|null, playedOf?: (f: string) => number, hand?: object[], played?: object[]}} [ctx] - decision state; played = full subset leaving the hand (Baron)
 * @returns {object} chips, mult, rounded score and unc = unresolved shared-suit lottery
 */
function predict(handsTable, fam, scoring, ctx) {
    const b0 = famBase(handsTable, fam);

    /* The Flint (build text): table BASE chips and mult halved — card chips, +mult and
       X-mult joker layers are NOT halved (they join after, per row 4202's measured halves) */
    const flint = /flint/i.test((ctx && ctx.boss) || '');
    const b = flint ? { chips: Math.floor(b0.chips / 2), mult: Math.floor(b0.mult / 2) } : b0;
    /* Splash (user-confirmed text): EVERY played card scores - seals, enhancements and
       joker per-card conditions evaluate over the full play, not the formal-hand subset.
       Corpus: High Card AceH on Mystic Summit+Splash scored 25x the subset model. */
    let sc = scoring;

    if (ctx && ctx.jk && ctx.jk.get('Splash') && Array.isArray(ctx.played) && ctx.played.length > sc.length) {
        sc = ctx.played;
    }

    const k = knownLayer(fam, sc, { ...ctx, lvl: b0.level });
    const chips = b.chips + (k.cflat || 0) + sc.reduce((s, c) => s + (c.debuffed ? 0 : CHIP(rv(c))), 0);
    /* lineup gate: the residual factor explains what the model missed under the lineup
       it was trained with; a buy/sell since then (measured over-preds 1.29x run
       1793030565, 1.4x run 1793030566 on TP across Saturn buys) must not apply it */
    const mult = (b.mult + k.flat) * (jokerSig[fam] === jSig(ctx) ? jokerFactor[fam] ?? 1 : 1) * k.xm;

    return { chips, mult, score: Math.round(chips * mult), unc: k.unc === true };
}

/**
 * Fold one observed play into the per-family RESIDUAL joker multiplier EMA: the modeled
 * stateful layer is divided out, jokerFactor learns only what it fails to explain.
 *
 * @param {string} fam - hand family that was played
 * @param {object[]} scoring - cards that scored
 *   (calibrate must receive the PRE-PLAY ctxOf snapshot: dividing a first occurrence by a
 *   post-play X3 it never earned poisons jokerFactor toward 1/3)
 * @param {number} baseChips - table base chips used for the play
 * @param {number} baseMult - table base mult used for the play
 * @param {number} delta - observed score of the play
 * @param {{jk?: Map<string, number>, dl?: number|null, playedOf?: (f: string) => number}} [ctx] - decision state at play time
 */
function calibrate(fam, scoring, baseChips, baseMult, delta, ctx) {
    let sc = scoring;

    if (ctx && ctx.jk && ctx.jk.get('Splash') && Array.isArray(ctx.played) && ctx.played.length > sc.length) {
        sc = ctx.played;
    }

    const k = knownLayer(fam, sc, ctx);
    const exp = (baseChips + (k.cflat || 0) + sc.reduce((s, c) => s + (c.debuffed ? 0 : CHIP(rv(c))), 0)) * (baseMult + k.flat) * k.xm;

    /* face-down scoring (The House/Mark): fake stand-in ranks must not train jokerFactor */
    const hid = sc.filter((c) => c.faceDown || c.rank === null || c.rank === undefined || c.rank === '').length;

    if (k.unc || hid >= 2) {
        return;
    }

    if (exp > 0 && delta > 0) {
        const f = Math.min(600, Math.max(0.05, delta / exp));

        jokerFactor[fam] = jokerFactor[fam] ? jokerFactor[fam] * 0.5 + f * 0.5 : f;
        jokerSig[fam] = jSig(ctx);
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
 * DNA JOKER farm target ("If first hand of round has only 1 card, add a
 * permanent copy to deck and draw it to hand" - live ef text in shopdump rows;
 * joker bought 5x in corpus, NEVER fired: the subset scorer always plays 2..5
 * cards so the lone-card trigger was unreachable and the deck engine dead).
 * First hand of a blind, play this ONE enhanced card alone: the copy lands in
 * the deck permanently (deck growth = more draws all run; Steel copies compound
 * X1.5-held economy; Gold copies pay $3/round; Mult/Glass copies score big).
 *
 * @param {object[]} handCards - playable hand cards (normalized)
 * @param {number} ante - current ante (engine pays only early; late targets eat hands)
 * @param {number} spareF - hands-1 capacity / remaining target AFTER the farm play;
 *   free-score types farm at any ratio, SCORE-contributing types need headroom
 * @param {Map<string,number>} [jk] - owned joker counts; with Sixth Sense a plain
 *   lone 6 (free score) is also a farm target -> free SPECTRAL every round (oracle)
 * @returns {(object | null)} {card, enh} best farm target or null
 */
function dnaFarmPick(handCards, ante, spareF, jk) {
    if (ante > 3) {
        return null;
    }

    /* ORACLE 10-31: Sixth Sense (uncommon) grants a SPECTRAL (never Soul/Black Hole)
       when the FIRST hand of a round plays a lone 6 (works through debuff — fires
       after scoring — but not when the boss bans the hand; lone High Card is always
       legal). A plain 6 played solo is ~16 chips: near-zero cost for a free spectral
       each round. An enhanced lone 6 double-farms (DNA copy + Sixth Sense). */
    const sixth = (jk && jk.get('Sixth Sense') > 0) || false;

    /**
     *
     * @param c
     */
    const enhOf = (c) => {
        const s = [c.key, c.values && c.values.type, ...((c.enhancements || []).map(String))].filter(Boolean).join(',');

        return /steel/.test(s) ? 'steel' : /gold/.test(s) ? 'gold' : /mult/.test(s) ? 'mult' : /glass/.test(s) ? 'glass' : null;
    };

    const RV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, Jack: 11, Queen: 12, King: 13, Ace: 14 };

    /* rank order: steel (pure economy, costs ZERO score), gold ($3/round forever,
       scores as High Card anyway), then mult/glass (real score cards -> spareF gate) */
    const want = [['steel', 0], ['gold', 0], ['mult', 1.35], ['glass', 1.35]];
    const cands = handCards.map((c) => ({ card: c, enh: enhOf(c) })).filter((o) => o.enh !== null && !o.card.debuffed && !o.card.faceDown);

    for (const [kind, need] of want) {
        const pool = cands.filter((o) => o.enh === kind && spareF >= need);

        if (pool.length) {
            pool.sort((a, b) => (RV[b.card.rank] ?? 0) - (RV[a.card.rank] ?? 0));

            return pool[0];
        }
    }

    if (sixth) {
        const six = handCards.filter((c) => (c.actions || []).includes('select') && (c.rank === '6' || c.rank === 6) && !c.debuffed && !c.faceDown);

        if (six.length) {
            return { card: six[0], enh: 'sixth' };
        }
    }

    return null;
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
    const ch = ctx && ctx.boss === 'Crimson Heart' && ctx.jk && ctx.jk.size ? chVariants(ctx) : null;

    for (let k = 1; k <= Math.min(5, playable.length); k++) {
        for (const cs of combos(playable, k)) {
            const e = evalHand(cs);
            /* played set = the whole candidate cs (Baron: kickers leave the hand too) */
            const p0 = predict(handsTable, e.fam, e.scoring, ctx ? { ...ctx, played: cs } : ctx).score;
            /* Crimson Heart: EV over which joker slot is disabled this hand */
            let p = p0;

            if (ch) {
                let s = 0;

                for (const vr of ch.v) {
                    s += vr.w * predict(handsTable, e.fam, e.scoring, { ...vr.ctx, played: cs }).score;
                }

                p = s / ch.tot;
            }

            /* face-down cards: identities unresolvable until play (House/Mark/Fish).
               2+ unknowns: live Mark run 1793027955 TP 702 scored 140 (0.20), 924->380
               (0.41) -> guard 0.3. Exactly 1: plays WITH one face-down card measured
               med 0.36 of the phantom-rank pred (n=127 census 10-31) -> guard 0.4 on
               top of the 13-rank EV below */
            const hid = cs.filter((c) => c.faceDown).length;
            const guard = hid >= 2 ? 0.3 : (hid === 1 ? 0.4 : 1);

            /* LONE FACE-DOWN = 13-RANK EV (10-31 census: plays with exactly one
               face-down card scored med 0.36 of pred, n=127 — the phantom stand-in
               rank R[] invents a made hand that the real card matches ~1/13 of the
               time): average predict() over the 13 possible true ranks instead of
               trusting the stand-in. Cards score at their TRUE rank on play, so the
               EV over the unknown identity is the honest expectation */
            let pe = p;

            if (hid === 1 && !ch) {
                const fdIdx = cs.findIndex((c) => c.faceDown);
                const base = cs[fdIdx]; /* normalizeHand stand-in: keep its suit, swap rank */
                let acc = 0;

                for (const rk of ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King']) {
                    const cs2 = cs.map((c, i) => (i === fdIdx ? { ...base, rank: rk, faceDown: false } : c));
                    const e2 = evalHand(cs2);

                    acc += predict(handsTable, e2.fam, e2.scoring, ctx ? { ...ctx, played: cs2 } : ctx).score;
                }

                pe = acc / 13;
            }

            /* HELD-STEEL ECONOMICS (oracle: each Steel card gives X1.5 while it stays in
               hand): a candidate that plays s of the held steels forfeits X1.5^s on every
               FUTURE hand this blind (cards return to the deck next blind). EV bridge
               proxy: score x (1 + futureHands x (1.5^retainedSteel - 1)) - a steel play
               must beat retention by that multiple, it is not forbidden.
               ponytail: single-blind horizon; multi-blind compounding lands with E' */
            const steelHeld = playable.filter(isSteel).length;
            const steelPlayed = cs.filter(isSteel).length;
            const fh = Math.max(0, Math.min(3, (ctx && ctx.hl ? ctx.hl - 1 : 0)));
            const keepX = steelHeld > steelPlayed && fh > 0 ? 1 + fh * (1.5 ** (steelHeld - steelPlayed) - 1) : 1;

            out.push({
                cards: cs, ...e, pred: Math.round(pe * guard), util: Math.round(pe * guard * ((bias && bias[e.fam]) || 1) * keepX),
            });
        }
    }

    /* pick by strategy-WEIGHTED utility (util); pred is the EV INCLUDING the face-down
       guard so banking/pacing against a blind target stays honest.
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
/* FAMS scale imported from mc.mjs (single source, 11-04) */

function drawScore(cs) {
    const e = evalHand(cs);
    const s = FAMS[e.fam] || 0;

    return s + e.scoring.reduce((t, c) => t + CHIP(rv(c)), 0);
}

/**
 * COHORT-14 draw-EV (11-01, user-directed: discards must weigh WHAT CAN STILL COME UP
 * in the remaining deck, not just the current shape). For a keep-set, expected score
 * gain = P(draw an out within k redraws) x (better-family value - current value), with
 * outs K counted from the unseen deck index (manifest minus run-seen cards) and the
 * gain boosted when the upgraded hand IS the grind family (its levels multiply it).
 * ponytail: linear P ~= k*K/N (exact hypergeom only matters once farms shrink N; N>=10
 * guard here); single best draw per keep, no multi-draw compounding.
 *
 * @param {object[]} keep - candidate 5-card keep
 * @param {object} ctx - {uidx: unseenIndex | null, disc: number, fam: string|null, lvl: number}
 * @returns {number} expected draw value in FAMS units (0 without deck data or discards)
 */
function drawEV(keep, ctx) {
    const ix = ctx && ctx.uidx;
    const k = Math.min(5, (ctx && ctx.disc) || 0);

    if (!ix || !k || ix.total < 10) {
        return 0;
    }

    const e = evalHand(keep);
    const s0 = FAMS[e.fam] || 0;
    const lvl = Math.max(1, (ctx && ctx.lvl) || 1);

    /* @param {string} f - family the draw would complete @returns {number} grind-level multiplier */
    const boost = (f) => (f === ctx.fam ? 1 + 0.35 * (lvl - 1) : 1);

    /* @param {number} K - unseen outs @returns {number} P(>=1 hit in k draws) approx */
    const pr = (K) => Math.min(0.95, (K * k) / ix.total);
    let best = 0;

    /* 4-flush: remaining cards of the suit still in the deck */
    const byS = {};

    for (const c of keep) {
        byS[c.suit] = (byS[c.suit] || 0) + 1;
    }

    for (const [s, n] of Object.entries(byS)) {
        if (n === 4 && s0 < FAMS.Flush) {
            best = Math.max(best, (FAMS.Flush - s0) * pr(ix.suit[s] || 0) * boost('Flush'));
        }
    }

    /* 4-straight window (Ace plays both ends) */
    const rset = new Set(keep.map(rv));

    if (rset.has(14)) {
        rset.add(1);
    }

    if (rset.size >= 4 && s0 < FAMS.Straight) {
        for (let w = 1; w <= 10; w++) {
            const win = [w, w + 1, w + 2, w + 3, w + 4];
            const miss = win.filter((r) => !rset.has(r));

            if (miss.length <= 1) {
                const K = miss.reduce((t, r) => t + (ix.rank[r] || 0), 0);

                best = Math.max(best, (FAMS.Straight - s0) * pr(K) * boost('Straight'));
            }
        }
    }

    /* pair -> trips (the grind family's bread-and-butter upgrade) */
    if (e.fam === 'Pair' && s0 < FAMS['Three of a Kind']) {
        const pc = {};

        for (const c of keep) {
            pc[rv(c)] = (pc[rv(c)] || 0) + 1;
        }

        const pk = Number(Object.keys(pc).find((r) => pc[r] === 2));

        if (pk) {
            best = Math.max(best, (FAMS['Three of a Kind'] - s0) * pr(ix.rank[pk] || 0) * boost('Three of a Kind'));
        }
    }

    return best;
}

/**
 * Pick up to 5 cards to discard.
 *
 * @param {object[]} handCards - hand cards from the observation
 * @param {object} bestPlay - best planned play (currently unused)
 * @param {string | null} lock - family locked by Eye/Mouth boss, or null
 * @param ctx
 * @returns {object[]} cards to discard
 */
function chooseDiscard(handCards, bestPlay, lock, ctx) {
    handCards = normalizeHand(handCards);
    const selectable = handCards.filter((c) => (c.actions || []).includes('select'));
    const live = selectable.filter((c) => !c.debuffed);
    const cards = live.length ? live : selectable;
    /* future hands this blind that the kept X1.5 per Steel will multiply (oracle held rule) */
    const fh = Math.max(0, Math.min(3, (ctx && ctx.hl ? ctx.hl - 1 : 0)));

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
    /* COHORT-23: sampled-deck EV replaces the linear outs heuristic when the real
       unseen multiset is known (deck manifest - run-seen); small hands skip MC (dN=0) */
    const dN = Math.min(5, Math.max(0, selectable.length - 5));
    const useMc = Array.isArray(ctx && ctx.udeck) && ctx.udeck.length >= 10 && dN > 0 && five.length > 1;

    for (const f of five) {
        const steel = f.filter(isSteel).length;
        const s = useMc
            ? mcHold(f, dN, ctx) * (steel && fh > 0 ? 1 + fh * (1.5 ** steel - 1) : 1)
            : drawScore(f) * (steel && fh > 0 ? 1 + fh * (1.5 ** steel - 1) : 1) + drawEV(f, ctx);

        if (!best || s > best.s) {
            best = { s, f };
        }
    }

    const keepIds = new Set(best.f.map((c) => c.id));
    const disc = selectable.filter((c) => !keepIds.has(c.id)).sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || (isSteel(a) ? 1 : 0) - (isSteel(b) ? 1 : 0) || rv(a) - rv(b));

    // nothing to cut: dump single lowest junk that isn't in best pair (steels are not junk)
    if (disc.length === 0) {
        /* MC v2 (11-05): hand==5 single-discard IS a draw-EV decision ("which one card
           hurts least to replace") - the rv junk-sort breaks flush engines (dumps the
           low suited card). Sample-based pick over the real deck instead; invariants
           kept: debuffed cards are ALWAYS dump-preferred (they score 0), steels never
           are. Deckless obs keeps the old junk-sort untouched. */
        const mc5 = Array.isArray(ctx && ctx.udeck) && ctx.udeck.length >= 10 && selectable.length === 5;
        const debuff = selectable.filter((c) => c.debuffed);
        const cand = debuff.length ? debuff : selectable.filter((c) => !isSteel(c));

        if (mc5 && cand.length) {
            let pick = null;
            let bestV = 0;

            for (const c of cand) {
                const v = mcHold(selectable.filter((x) => x.id !== c.id), 1, ctx);

                if (v !== null && (pick === null || v > bestV)) {
                    bestV = v;
                    pick = c;
                }
            }

            if (pick) {
                return [pick];
            }
        }

        const worst = [...selectable].sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || (isSteel(a) ? 1 : 0) - (isSteel(b) ? 1 : 0) || rv(a) - rv(b))[0];

        return [worst];
    }

    return disc.slice(0, 5);
}

export { famBase, predict, calibrate, allSubsetEvals, dnaFarmPick, chooseDiscard, drawEV, ctxOf, resetRoundReps, syncReps, getRoundReps, resetSeen, seenN };
