/* Hand-phase decision engine: play vs discard per blind (split from driver 10-29). */
import { allSubsetEvals, chooseDiscard, ctxOf, syncReps } from './play.mjs';
import { say, jw } from './knowledge.mjs';
import { execHighlight, syncJokerSig } from './acts.mjs';

/**
 * Choose and execute the best play or discard for the current hand.
 *
 * @param {object} obs - observation snapshot for the hand/play phase
 * @param {object} st - live state holder: bank, bias, antePlayed, anteRank, anteRankAnte, stake
 * @returns {Promise<object>} decision record with action, act result, and score-estimate fields
 */
export async function playTurn(obs, st) {
    const { antePlayed, anteRank, bias, bank } = st;

    const run = obs.run;
    const hand = obs.hand || [];

    syncJokerSig(obs);

    /* current_score never updates on this build; estimate banked via our own predictions
   run.chips is this blind's real accumulated score (verified 0->40->54->98 growth, resets per blind); bank pred only as fallback */
    const truthC = run.chips ?? null;
    const rem = truthC !== null ? Math.max(0, (run.blind?.target ?? 0) - truthC) : Math.max(0, (run.blind?.target ?? 0) - bank.pred);
    const bname = run.blind?.name || '';
    // must play exactly 5 cards
    const forced5 = /Psychic/.test(bname);
    // Mouth: only ONE hand type all blind (lock it). Eye: NO REPEATING a type (ban played ones)
    const mouthOnly = bname === 'The Mouth';
    const eyeNoRep = bname === 'The Eye';

    syncReps(obs.hands);
    const preCtx = ctxOf(obs);

    /* ponytail: st stays the single source of truth for the two mutated fields; the
       rule can't tell a write-through from a missed destructure */
    /* eslint-disable unicorn/consistent-destructuring */
    if (st.anteRankAnte !== run.ante) {
        anteRank.clear();
        antePlayed.clear();
        st.anteRankAnte = run.ante;
    }
    /* eslint-enable unicorn/consistent-destructuring */

    if (/Pillar|Fish|Mark|House/.test(bname)) {
    /* SETTLED (68-obs census): Pillar DOES arrive with game-set debuffed flags -
   exactly the re-shuffled played copies, 1-6 per hand (0 only on the ante's
   first hand, correctly, before any plays). Fish/Mark/House raw stays 0:
   their mechanics are face-down/one-family, not per-card debuff in this
   bridge. lineage >=4 below is a conservative no-op floor, c.debuffed is
   the authority; keep dcens cheap to catch regression if the build changes */
        jw({ e: 'dcens', b: bname, raw: hand.filter((c) => c.debuffed).length, n: hand.length, led: Object.fromEntries(anteRank) });
    }

    if (bname === 'The Pillar') {
        for (const c of hand) {
            if ((anteRank.get(c.rank) ?? 0) >= 4) {
                c.debuffed = true;
            }
        }
    }

    let ev = allSubsetEvals(hand, obs.hands, bias, preCtx);

    if (forced5) {
        ev = ev.filter((o) => o.cards.length === 5);
    }

    if (eyeNoRep) {
        const f = ev.filter((o) => !(bank.eyeFams || {})[o.fam]);

        if (f.length) {
            ev = f;
        }
    }

    if (mouthOnly && bank.lockFam) {
        const f = ev.filter((o) => o.fam === bank.lockFam);

        if (f.length) {
            ev = f;
        } else if ((run.discards_left ?? 0) > 0) {
            ev = [];
        }
    }

    /* The Mouth locks the WHOLE blind to the first play's family, and every later
   off-family hand is rejected for 0: prefer a REPEATABLE family (pairs-based
   hands recur from the same ranks) within 75% of the best pred. Run 1793026549
   locked Straight at 2930, could not repeat it, had three hands rejected and
   died 582 short with Two Pair candidates (2728) sitting in hand */
    if (mouthOnly && !bank.lockFam && ev.length) {
        const maxP = Math.max(...ev.map((o) => o.pred));
        const rep = ev.find((o) => ['Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'Four of a Kind'].includes(o.fam) && o.pred >= maxP * 0.75);

        if (rep && rep !== ev[0]) {
            ev = [rep, ...ev.filter((o) => o !== rep)];
        }
    }

    const handsLeft = run.hands_left ?? 1;
    const discLeft = run.discards_left ?? 0;

    if (!ev.length) {
        if (discLeft > 0) {
            const d = chooseDiscard(hand, null, bank.lockFam ?? null);

            if (d && d.length) {
                const r = await execHighlight(obs, d, 'discard_cards_from_highlighted');

                if (r.ok) {
                    return { action: 'discard', r, n: d.length };
                }
            }
        }

        /* all cards can be debuffed (bosses) yet stay legally playable for zero — never stall on filtering */
        let playable = hand.filter((c) => !c.debuffed && (c.actions || []).includes('select'));

        if (!playable.length) {
            playable = hand.filter((c) => (c.actions || []).includes('select'));
        }

        const five = playable.slice(0, 5);

        if (!five.length) {
            return { action: 'stuck' };
        }

        const r = await execHighlight(obs, five, 'play_cards_from_highlighted');

        if (r.ok) {
            for (const c of five) {
                antePlayed.add(c.id);
            }
        }

        return { action: 'play', r, fam: '?', scoring: [], pred: 0, rem, preCtx, boss: bname };
    }

    const best = ev[0];
    /* FACE-DOWN HONEST SCALE (corpus calibration 804 runs: actual/pred median The Mark
   0.62, The Fish 0.56, The House 0.90 - virtual mid ranks overstate ~40%): shrink
   pred for the discard/fish thresholds only, so we fish faces instead of dumping
   hands at fantasy scores. Play-now uses real run.chips for rem, unaffected. */
    const faceDownF = hand.some((c) => c.rank === null || c.rank === undefined);
    const pEff = faceDownF ? best.pred * 0.6 : best.pred;

    /* The Pillar ("Cards played previously this Ante are debuffed" — ef text) debuffs
   ALL FOUR copies of any rank played earlier this ante — copies return from the
   discard pile into later draws already dead, and the game never sets the
   debuffed FLAG (verified via 27347-era deaths: id-lineage was observation-positional
   and missed every re-drawn copy). Rank counts >=4 => in-hand copies are dead;
   mark them debuffed pre-eval so predictions and family choice avoid them. */
    if (bname === 'The Pillar' && discLeft > 0 && pEff < rem) {
        const inBest = new Set(best.cards.map((c) => c.id));
        const dead = hand.filter((c) => ((anteRank.get(c.rank) ?? 0) >= 4 || c.debuffed) && (c.actions || []).includes('select') && !inBest.has(c.id));

        if (dead.length) {
            const r0 = await execHighlight(obs, dead.slice(0, 5), 'discard_cards_from_highlighted');

            if (r0.ok) {
                return { action: 'discard', r: r0, n: dead.length };
            }
        }
    }

    /* The Mouth (71854: hands 2-4 with FRESH families scored 0 - "the first played
   hand of the round is the only hand which can score"): the blind rides on the
   first hand, so pace it as all-or-nothing and fish discards into it instead of
   dividing the target by handsLeft and playing a 5500-vs-22000 hand "on budget" */
    const needPer = bname === 'The Mouth' && !bank.lockFam ? rem : rem / Math.max(1, handsLeft);
    /* FISH THE LAST HAND (Needle class: 13 deaths with dl=4 untouched - the old
   handsLeft>1 guard made Needle discard dead weight): when the projected hand
   falls short of the score needed in the hands remaining, spend discards to
   upgrade it. A discard cannot lose the round - only the play can - so this
   is strictly free equity (Water's no-discard fail just falls through) */
    const needMore0 = discLeft > 0 && pEff < needPer;

    /* ONE-DISCARD DESPERATION CAP (Red stake; 10-29 cohort: a1-big deaths with lvlAct 0 -
   pred < average need made MULTI-discard spirals: every failed upgrade gamble ate one
   of the four hands the own budget counted on, doubling needPer each time). Max one
   upgrade gamble per hand; after that score with what we have. */
    if (bank.hlMark !== handsLeft) {
        bank.hlMark = handsLeft;
        bank.handDisc = 0;
    }

    /* eslint-disable-next-line unicorn/consistent-destructuring -- live getter, not a snapshot */
    const needMore = needMore0 && !((run.stake ?? st.stake) === 2 && bank.handDisc >= 1);

    if (needMore) {
        const d = chooseDiscard(hand, best, bank.lockFam ?? null);

        if (d && d.length) {
            bank.handDisc += 1;
            const r = await execHighlight(obs, d, 'discard_cards_from_highlighted');

            if (r.ok) {
                return { action: 'discard', r, n: d.length };
            }

            say('discard fail', r.error?.code, '- playing instead');
        }
    }

    const r = await execHighlight(obs, best.cards, 'play_cards_from_highlighted');

    if (r.ok && Array.isArray(r.result?.hands)) {
        syncReps(r.result.hands);
    }

    if (r.ok) {
        for (const c of best.cards) {
            antePlayed.add(c.id);

            if (c.rank) {
                anteRank.set(c.rank, (anteRank.get(c.rank) ?? 0) + 1);
            }
        }
    }

    if (mouthOnly && r.ok && !bank.lockFam) {
        bank.lockFam = best.fam;
    }

    if (eyeNoRep && r.ok) {
        (bank.eyeFams = bank.eyeFams || {})[best.fam] = 1;
    }

    return { action: 'play', r, fam: best.fam, scoring: best.scoring, cards: best.cards, pred: best.pred, rem, preCtx, boss: bname };
}
