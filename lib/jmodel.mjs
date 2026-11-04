/* jmodel.mjs — modeled contribution of state-dependent jokers to a hand prediction
   (extracted verbatim from play.mjs 11-04 refactor wave): the flat/xmult/cflat layers
   plus the Crimson-Heart random-disable lottery variants. Pure: no game state, no IO. */

import { SUITS, isSteel } from './eval.mjs';
import { COND_JOKER } from './jokers.mjs';

/* Which played-hand families CONTAIN a given sub-hand (11-05 TRUTH semantics of the
   "+N if played hand contains a X" clan): evaluated on the rank multiset of a normal
   5-card play - Flushes/Straights are always rank-distinct, 4K/House contain trips
   and pairs, House contains two pairs. */
const CONTAINS = {
    Pair: new Set(['Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'House', 'Four of a Kind', 'Five of a Kind']),
    'Two Pair': new Set(['Two Pair', 'Full House', 'House', 'Four of a Kind', 'Five of a Kind']),
    'Three of a Kind': new Set(['Three of a Kind', 'Full House', 'House', 'Four of a Kind', 'Five of a Kind', 'Flush House']),
    Straight: new Set(['Straight', 'Straight Flush']),
    Flush: new Set(['Flush', 'Straight Flush', 'Flush Five', 'Flush House']),
};

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
 * @param {object} [ctx] - ctxOf decision snapshot (jk/jv maps, boss text, unseen index, played ledger)
 * @returns {{flat: number, cflat: number, xm: number, unc: boolean}} additive mult, chips-in-multiplier additive flat, xmult factor, and the unresolved-shared-suit flag
 */
export function knownLayer(fam, scoring, ctx) {
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

    /* CONDITIONAL-FAMILY CLAN (11-05 TRUTH out/joker_truth.json): +N chips/Mult when
       the PLAYED hand contains cond.fam - sly 50c/Pair ... crafty 80c/Flush, the
       +mult twins jolly/mad/zany/crazy/droll. Previously junked as "vanilla weak". */
    for (const [nm, cond] of Object.entries(COND_JOKER)) {
        const cnt = n(nm[0].toUpperCase() + nm.slice(1));

        if (cnt > 0 && (CONTAINS[cond.fam]?.has(fam) ?? fam === cond.fam)) {
            if (cond.chips) {
                cflat += cond.chips * cnt;
            } else {
                flat += cond.mult * cnt;
            }
        }
    }

    /* DECK-COUNT ENHANCEMENT SYNERGY (11-05 TRUTH): Stone Joker +25 chips per
       m_stone card IN FULL DECK (cfg extra=25, NOT vanilla 50, NOT per scored).
       The GAME exposes its own counter live: values.stone_tally (turn-row census -
       {extra:25, stone_tally:1} owned Stone Joker) - use extra*stone_tally when the
       row is present, fall back to extra*ctx.stone (deck manifest tally). */
    const sj = (ctx.jv && ctx.jv.get('Stone Joker')) || [];

    if (sj?.[0]?.stone_tally !== undefined) {
        cflat += (sj[0].extra ?? 25) * sj[0].stone_tally * n('Stone Joker');
    } else {
        cflat += 25 * n('Stone Joker') * (ctx.stone || 0);
    }

    /* Steel Joker X1.2 per m_steel in full deck (cfg extra=0.2); live steel_tally
       census pending, deck-manifest count until then */
    xm *= (1 + 0.2 * (ctx.steel || 0)) ** n('Steel Joker');

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

    /* SUIT-SYNERGY JOKERS (blob TRUTH 11-04): Arrowhead (j_arrowhead extra=50) +50 Chips
       per played Spade when scored; Onyx Agate (j_onyx_agate extra=7) +7 Mult per played
       Club; Bloodstone (j_bloodstone {odds=2, Xmult=1.5}) rolls 1-in-2 PER Heart card for
       X1.5 (independent -> EV 1.25^hearts, and unc like the Ancient lottery: a realized
       lucky/unlucky hand must not train the residual). Smeared Joker in THIS build is
       "Hearts and Diamonds count as the same suit, Spades and Clubs count as the same
       suit" (blob text - NOT the vanilla Hearts<->Spades rule), so it merges the
       Spade/Club and Heart/Diamond counts for every suit trigger. Debuffed cards are
       skipped for consistency with the Ancient tally. */
    if (n('Arrowhead') + n('Onyx Agate') + n('Bloodstone') > 0) {
        const smeared = n('Smeared Joker') > 0;
        const cnt = {};

        for (const c of scoring) {
            if (!c.debuffed) {
                cnt[c.suit] = (cnt[c.suit] || 0) + 1;
            }
        }

        const sp = (cnt.Spades || 0) + (smeared ? (cnt.Clubs || 0) : 0);
        const cl = (cnt.Clubs || 0) + (smeared ? (cnt.Spades || 0) : 0);
        const he = (cnt.Hearts || 0) + (smeared ? (cnt.Diamonds || 0) : 0);

        if (sp) {
            cflat += 50 * n('Arrowhead') * sp;
        }

        if (cl) {
            flat += 7 * n('Onyx Agate') * cl;
        }

        if (he && n('Bloodstone') > 0) {
            xm *= 1.25 ** (he * n('Bloodstone'));
            unc = true;
        }
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

            if (name === 'Ride the Bus' && typeof v.mult === 'number' && v.mult > 0) {
                flat += v.mult;
            }

            /* Constellation: like Obelisk, growth lives in the x_mult store (per planet used).
               Oops! All 6s (probabilistic retrigger of listed probabilities — run-wide
               variance, not per-score uncertainty) stays unmodeled until store shapes
               are observed; Ride the Bus growth IS observed in values.mult (0->6+) and
               is added above (oracle 10-31: +1 Mult per consecutive no-scoring-face hand) */
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

/**
 * Crimson Heart ("One random Joker disabled every hand" - build ef text, run
 * 1793050982 where pred ran 3-4x actual when the disabled slot held the big
 * x-mult) variant set: one prediction context per joker slot that could be
 * disabled, weighted by copy count, so subset EV prices the random disable.
 *
 * @param {object} ctx - decision context from ctxOf
 * @returns {{v: {w: number, ctx: object}[], tot: number}} weighted disable variants
 */
export function chVariants(ctx) {
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
