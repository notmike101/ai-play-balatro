// play.mjs — score prediction, calibration, subset evaluation, discard heuristics (pure, no link).
import { evalHand, combos, rv, CHIP, BASE_IDX, SUITS } from './eval.mjs';
import { jokerFactor, jokerSig } from './knowledge.mjs';

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
    /* Supernova (ORACLE text 10-29): +1 Mult per times the scoring hand has been played
       THIS RUN, retroactive from purchase - so playedOf (game's own hands-table counter)
       +1 (current play) is the formula. The values.t_mult store stays 0 even at 28 plays
       (display does not reflect the effect; same quirk class as Stencil's slot-X store),
       so never gate it on the store. */
    flat += n('Supernova') * ((ctx.playedOf ? ctx.playedOf(fam) : 0) + 1);

    if (scoring.some((c) => !c.debuffed && FACE_RANKS.has(c.rank))) {
        xm *= 2 ** n('Photograph');
    }

    /* Baseball Card (ORACLE text): X1.5 per UNCOMMON joker owned, multiplicative; rare
       (Baseball itself!) and legendary do NOT count. Rarity is not in the observation -
       set below is the ORACLE's full uncommon table (10-29), superset of the observed
       pool; names unseen in shop rows should still be spot-checked against shop offers
       as they appear (oracle: "verify these for yourself as they come up"). */
    const UNCOM = new Set(['Joker Stencil', 'Four Fingers', 'Mime', 'Ceremonial Dagger', 'Marble Joker', 'Loyalty Card', 'Dusk', 'Fibonacci', 'Steel Joker', 'Hack', 'Pareidolia', 'Space Joker', 'Burglar', 'Blackboard', 'Sixth Sense', 'Constellation', 'Hiker', 'Card Sharp', 'Madness', 'Seance', 'Vampire', 'Shortcut', 'Hologram', 'Cloud 9', 'Rocket', 'Midas Mask', 'Luchador', 'Gift Card', 'Turtle Bean', 'Erosion', 'To the Moon', 'Stone Joker', 'Lucky Cat', 'Bull', 'Diet Cola', 'Trading Card', 'Flash Card', 'Spare Trousers', 'Ramen', 'Seltzer', 'Castle', 'Mr. Bones', 'Acrobat', 'Sock and Buskin', 'Troubadour', 'Certificate', 'Smeared Joker', 'Throwback', 'Rough Gem', 'Bloodstone', 'Arrowhead', 'Onyx Agate', 'Glass Joker', 'Showman', 'Flower Pot', 'Merry Andy', 'Oops! All 6s', 'The Idol', 'Seeing Double', 'Matador', 'Satellite', 'Cartomancer', 'Astronomer', 'Bootstraps']);

    if (n('Baseball Card') > 0) {
        let un = 0;

        for (const [nm, c] of jk) {
            if (UNCOM.has(nm)) {
                un += c;
            }
        }

        xm *= 1.5 ** un;
    }

    /* HELD Steel cards score X1.5 per card while they stay in hand (ORACLE confirmed the
       held effect exists via Mime text), and Mime retriggers held-in-hand effects once
       more per copy. Steel encodes as key m_steel (502 rows observed).
       ponytail: Blue-seal held (+1 hand per seal, retriggers too) unmodeled - no S:Blue
       rows in the corpus yet; Gold held money is economy, not score */
    if (ctx.hand && ctx.hand.length) {
        const playedIds = new Set((ctx.played || scoring).map((c) => c.id));
        const heldSteel = ctx.hand.filter((c) => !playedIds.has(c.id) && isSteel(c)).length;

        if (heldSteel) {
            xm *= 1.5 ** (heldSteel * (1 + n('Mime')));
        }
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

            /* Joker Stencil IN THIS BUILD: Xmult = 1 + EMPTY joker slots (corpus-confirmed:
               observed x_mult jk1->5 x42, jk2->4 x42, jk3->3 x87, jk4->2 x558, jk5->1 x259).
               NOT the vanilla level-based rule. */
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
            /* Blue Joker (ORACLE text): +2 Chips per card still full-in-deck (never
               drawn this run; the rank|seen tracker marks every hand appearance, so
               held cards are excluded, and ids need no cross-observation identity) */
            if (name === 'Blue Joker' && typeof v.extra === 'number' && ctx.unseen) {
                cflat += v.extra * ctx.unseen;
            }
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

            /* Card Sharp: X3 Mult iff the SAME family was already played this blind;
               roundReps is driven by the game's own per-row played counters (recorded
               via counter diff), never by the predicted family */
            if (name === 'Card Sharp' && ctx.pl && ctx.pl[fam] > 0) {
                xm *= typeof v.extra?.Xmult === 'number' && v.extra.Xmult > 1 ? v.extra.Xmult : 3;
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

            /* Loyalty Card: X4 Mult on every 5th played hand; the build exposes a live
               countdown (extra{Xmult:4,every:5} + loyalty_remaining). Run 1793000317
               measures the boundary: the play observed with remaining=1 gained PLAIN,
               then remaining=0 held across a discard and that hand gained X4; after
               firing the counter resets to `every`. So the pre-play observation
               remaining===0 is the boost hand; the countdown is always present once
               owned, so a missing one marks the row uncertain rather than guess. */
            if (name === 'Loyalty Card' && v.extra && typeof v.extra.Xmult === 'number' && v.extra.Xmult > 1) {
                if (v.loyalty_remaining === 0) {
                    xm *= v.extra.Xmult;
                } else if (v.loyalty_remaining === undefined || v.loyalty_remaining === null) {
                    unc = true;
                }
            }

            /* Baron: X(extra) per KING HELD IN HAND, not played — the build stores the
               displayed X value itself in extra (measured run 1793020656: extra:1.5,
               Pair pred 208 scored 312 = x1.50 with one unplayed King in the 8-card
               hand; (1+extra) would have given x2.5=520, ruled out by the same row).
               ALL played cards leave the hand — including non-scoring kickers and
               debuffed ones — so held = Kings(hand) - Kings(played), falling back to
               the scoring set only when no played set was supplied. Without the
               pre-play hand the row is marked uncertain so the factor never learns
               a phantom boost. */
            if (name === 'Baron' && typeof v.extra === 'number' && v.extra > 0) {
                if (!ctx.hand || !ctx.hand.length) {
                    unc = true;
                } else {
                    /**
                     * King rank test tolerant of notation variants.
                     *
                     * @param {object} c - card
                     * @returns {boolean} true when the card is a King
                     */
                    const isK = (c) => c && (c.rank === 'King' || c.rank === 'K');
                    const held = Math.max(0, ctx.hand.filter(isK).length - (ctx.played || scoring).filter(isK).length);

                    /* ORACLE: Mime retriggers HELD-in-hand effects - Baron's King Xmult
                       applies once more per Mime copy */
                    xm *= v.extra ** (held * (1 + n('Mime')));
                }
            }
        }
    }

    return { flat, cflat, xm, unc };
}

const roundReps = {};
let roundBase = null;

/* RUN-SCOPE SEEN-CARDS tracker (B2, Blue Joker +2 chips per card still full-in-deck —
   never drawn this run and not in hand, ORACLE text). Card ids are per-observation, so
   copy identity uses rank|suit + the deck manifest (obs.deck.composition rows carry a
   per-combo COUNT): unseen = SUM copies - max copies ever seen simultaneously per combo.
   ponytail: duplicate combos drawn on DIFFERENT hands under-count seen (same-copy redraw
   and fresh copy are indistinguishable without ids) - Blue overpredicts by <=2/dup;
   face-down draws stay "unseen" (identity hidden) and do the same direction. */
const seenMult = new Map();

/**
 * Record every identifiable card that has surfaced in a hand (drawn = seen).
 *
 * @param {(object[] | undefined)} cards - hand cards from an observation
 */
function markSeen(cards) {
    const m = new Map();

    for (const c of cards || []) {
        if (c && c.rank !== null && c.rank !== undefined && c.suit) {
            const k = `${c.rank}|${c.suit}`;
            m.set(k, (m.get(k) || 0) + 1);
        }
    }

    for (const [k, n] of m) {
        if ((seenMult.get(k) ?? 0) < n) {
            seenMult.set(k, n);
        }
    }
}

/**
 * Copies still full-in-deck: never-drawn copies of every combo on the manifest.
 *
 * @param {(Array<(string | number)[]> | undefined)} comp - deck composition rows [rank, suit, enh, edition, seal, count]
 * @returns {(number | null)} unseen copy count, null when the manifest is unknown
 */
function unseenCopies(comp) {
    if (!Array.isArray(comp) || !comp.length) {
        return null; /* deck manifest unknown: never guess - Blue stays unpriced */
    }

    let u = 0;

    for (const row of comp) {
        u += Math.max(0, (typeof row[5] === 'number' ? row[5] : 1) - (seenMult.get(`${row[0]}|${row[1]}`) ?? 0));
    }

    return u;
}

/**
 * Drop the run's memory of drawn cards (new run).
 */
function resetSeen() {
    seenMult.clear();
}

/**
 * Reset the per-blind repeat-family counters (new blind = new Balatro 'round',
 * which is Card Sharp's X3 condition window). Clears the baseline so the next
 * syncReps re-seeds it from the game's cumulative played counters.
 */
function resetRoundReps() {
    roundBase = null;

    for (const k of Object.keys(roundReps)) {
        delete roundReps[k];
    }
}

/**
 * Derive this blind's repeat counters from the game's OWN cumulative per-hand-type
 * counters: reps[fam] = played_now minus the blind-start baseline. The counter is the
 * single source of truth (predicted fam mislabels what the game actually scored) and
 * reps are derived, so the state is self-healing — a missed or pre-animation result
 * table is simply picked up by the next sync that sees the moved counter instead of
 * losing the delta forever. The first sync after a reset seeds the baseline; rows
 * without explicit counters contribute nothing; a missing table never clobbers state.
 *
 * @param {(object[] | undefined)} hands - current per-hand-type rows with played counters
 */
function syncReps(hands) {
    if (!Array.isArray(hands) || !hands.length) {
        return;
    }

    if (!roundBase) {
        roundBase = {};

        for (const h of hands) {
            const p = h && Number(h.played ?? h.times_played);

            if (h?.name && Number.isFinite(p)) {
                roundBase[h.name] = p;
            }
        }

        return;
    }

    for (const k of Object.keys(roundReps)) {
        delete roundReps[k];
    }

    for (const h of hands) {
        const p = h && Number(h.played ?? h.times_played);

        if (h?.name && Number.isFinite(p) && roundBase[h.name] !== undefined) {
            roundReps[h.name] = Math.max(0, p - roundBase[h.name]);
        }
    }
}

/**
 * Repeat counts for the CURRENT blind (Card Sharp: fam already played this round).
 *
 * @returns {object} fam -> times played this blind
 */
function getRoundReps() {
    return roundReps;
}

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
        /**
         * Recorded plays of a family from the hands table.
         *
         * @param {string} f - hand family name
         * @returns {number} times played this run
         */
        playedOf: (f) => (obs.hands || []).find((h) => h.name === f)?.played ?? 0,
        pl: { ...roundReps },
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
 * Steel card test: enhancement lives in the card key (m_steel) or values.type.
 *
 * @param {object} c - card observation
 * @returns {boolean} true when the card is Steel (X1.5 while HELD in hand)
 */
const isSteel = (c) => (typeof c.key === 'string' && c.key.includes('steel'))
    || (typeof (c.values && c.values.type) === 'string' && c.values.type.includes('steel'));

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
 * Crimson Heart ("One random Joker disabled every hand" - build ef text, run
 * 1793050982 where pred ran 3-4x actual when the disabled slot held the big
 * x-mult) variant set: one prediction context per joker slot that could be
 * disabled, weighted by copy count, so subset EV prices the random disable.
 *
 * @param {object} ctx - decision context from ctxOf
 * @returns {{v: {w: number, ctx: object}[], tot: number}} weighted disable variants
 */
function chVariants(ctx) {
    const v = [];
    let tot = 0;

    for (const [nm, cnt] of ctx.jk) {
        const jk2 = new Map(ctx.jk);
        const jv2 = new Map(ctx.jv || []);

        if (cnt > 1) {
            jk2.set(nm, cnt - 1);

            const arr = jv2.get(nm);

            if (arr) {
                jv2.set(nm, arr.slice(0, -1));
            }
        } else {
            jk2.delete(nm);
            jv2.delete(nm);
        }

        v.push({ w: cnt, ctx: { ...ctx, jk: jk2, jv: jv2 } });
        tot += cnt;
    }

    return { v, tot };
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

            /* >=2 face-down cards: real identities unresolvable (House/Mark) — measured
               EV/stand-in-pred on live Mark run 1793027955: TP 702 scored 140 (0.20),
               TP 924 scored 380 (0.41); a lone unknown may still be the pair partner,
               so it keeps full credit */
            const hid = cs.filter((c) => c.faceDown).length;
            const guard = hid >= 2 ? 0.3 : 1;

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
                cards: cs, ...e, pred: Math.round(p * guard), util: Math.round(p * guard * ((bias && bias[e.fam]) || 1) * keepX),
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

    for (const f of five) {
        const steel = f.filter(isSteel).length;
        const s = drawScore(f) * (steel && fh > 0 ? 1 + fh * (1.5 ** steel - 1) : 1);

        if (!best || s > best.s) {
            best = { s, f };
        }
    }

    const keepIds = new Set(best.f.map((c) => c.id));
    const disc = selectable.filter((c) => !keepIds.has(c.id)).sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || (isSteel(a) ? 1 : 0) - (isSteel(b) ? 1 : 0) || rv(a) - rv(b));

    // nothing to cut: dump single lowest junk that isn't in best pair (steels are not junk)
    if (disc.length === 0) {
        const worst = [...selectable].sort((a, b) => (b.debuffed ? 1 : 0) - (a.debuffed ? 1 : 0) || (isSteel(b) ? 1 : 0) - (isSteel(a) ? 1 : 0) || rv(a) - rv(b))[0];

        return [worst];
    }

    return disc.slice(0, 5);
}

/**
 * Number of distinct rank|suit combos seen this run (selftest probe).
 *
 * @returns {number} seen combos
 */
function seenN() {
    return seenMult.size;
}

export { famBase, predict, calibrate, normalizeHand, allSubsetEvals, drawScore, chooseDiscard, ctxOf, knownLayer, resetRoundReps, syncReps, getRoundReps, markSeen, resetSeen, seenN };
