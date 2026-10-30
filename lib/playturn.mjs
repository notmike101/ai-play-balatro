/* Hand-phase decision engine: play vs discard per blind (split from driver 10-29). */

import { allSubsetEvals, calibrate, chooseDiscard, ctxOf, famBase, resetRoundReps, syncReps } from './play.mjs';
import { act, nudgeUnpause, observe } from './link.mjs';
import { planetFam, setPackMetaHands } from './shop.mjs';
import { planTargeted } from './strategy.mjs';

import { say, jw, sleep } from './knowledge.mjs';

import { deckProbe, execHighlight, syncJokerSig, useTargeted } from './acts.mjs';

/**

 Choose and execute the best play or discard for the current hand.

 * @param {object} obs - observation snapshot for the hand/play phase

 * @param {object} st - live state holder: bank, bias, antePlayed, anteRank, anteRankAnte, stake

 * @returns {Promise<object>} decision record with action, act result, and score-estimate fields
 */
async function playTurn(obs, st) {
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
            const d = chooseDiscard(hand, null, bank.lockFam ?? null, { hl: run.hands_left ?? null });

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
        const d = chooseDiscard(hand, best, bank.lockFam ?? null, { hl: run.hands_left ?? null });

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

/**
 * Which family this hand will actually play (picks the matching planet BEFORE playing).
 *
 * @param {object} obs - observation snapshot
 * @param {object} bank - live per-blind bank
 * @param {object} bias - live family bias
 * @returns {(string | null)} family name or null
 */
function peekPlayFam(obs, bank, bias) {
    syncJokerSig(obs);
    syncReps(obs.hands);

    let ev = allSubsetEvals(obs.hand || [], obs.hands, bias, ctxOf(obs));

    if (/Psychic/.test(obs.run?.blind?.name || '')) {
        ev = ev.filter((o) => o.cards.length === 5);
    }

    if (bank.lockFam && obs.run?.blind?.name === 'The Mouth') {
        const f = ev.filter((o) => o.fam === bank.lockFam);

        if (f.length) {
            ev = f;
        }
    }

    if (obs.run?.blind?.name === 'The Eye') {
        const f = ev.filter((o) => !(bank.eyeFams || {})[o.fam]);

        if (f.length) {
            ev = f;
        }
    }

    return ev.length ? ev[0].fam : null;
}

/**
 * Hand-phase pipeline: prep (bank sync, planet/tarot), playTurn, telemetry, calibration
 * and error recovery. Returns the possibly-refreshed observation and error streak.
 *
 * @param {object} obs0 - current observation
 * @param {object} ctx - {st, runStats, suitTally, stake, onHands, turnErrStreak} live context
 * @returns {Promise<{obs: object, turnErrStreak: number}>} updated loop state
 */
async function handleHand(obs0, ctx) {
    const { bank, bias } = ctx.st;

    let obs = obs0;
    let turnErrStreak = ctx.turnErrStreak;

    const bkey = `${obs.run.round}:${obs.run.blind?.name || ''}`;

    if (bank.key !== bkey) {
        Object.assign(bank, { key: bkey, pred: 0, byFam: {}, eyeFams: {}, target: obs.run.blind?.target ?? 0 });
        resetRoundReps();
    }

    /* Blind still alive with bank >= target => banked predictions overshot reality (no current_score in this build);
       true score is < target, so re-anchor to zero instead of believing the phantom "already won". */
    if (bank.target > 0 && bank.pred >= bank.target) {
        jw({ e: 'resync', bank: Math.round(bank.pred), target: bank.target });
        // only bound while blind alive: real score < target; keep zero (no real score field in this build)
        bank.pred = 0;
    }

    /* PLANET BANKRUPT FIX (164: Jupiter+Saturn sat [use] all of a3-a5 while the
       engine grinded L2 and died pred 90 - the peek-match gate meant a held
       planet only fires if its OWN fam plays this turn, which almost never
       repeats; levels are permanent, waiting buys nothing). Exception kept:
       level-decay bosses (The Arm erodes per play) - bank while it is up. */
    const pf = peekPlayFam(obs, bank, bias);
    const armUp = /decrease level/i.test((obs.run?.blind?.effect || []).join(' '));
    const pls = (obs.consumables || []).filter((c) => String(c.kind || '').toLowerCase() === 'planet' && (c.actions || []).includes('use'));
    const pc = (pf && pls.find((c) => planetFam(c) === pf)) || (!armUp ? pls[0] : null);
    const pfam = pc ? planetFam(pc) : null;

    if (pc) {
        const r = await act({ epoch: obs.epoch, action: 'use', target: pc.id });

        if (r.ok) {
            obs = r.result;
            jw({ e: 'planet', fam: pfam });
            ctx.runStats.lvl++;
        }
    }

    // targeted tarot on hand cards: select then use (Magician/Empress/Tower/Death/Hierophant)
    const ttPlans = planTargeted(obs, ctx.suitTally);

    /* Death-v3 PROVEN LIVE (1793089229 a1 Psychic: 'death leftcopy->best'
       ok:true on K-D/Q-D descending pair, consumed same blind) - the diag
       probe that surfaced the rank-ordering root cause is retired. */
    for (const tp of ttPlans) {
        obs = await useTargeted(obs, tp, ctx.suitTally);
    }

    const before = obs.run.chips ?? null;

    if ((obs.hands || []).length) {
        ctx.onHands(obs.hands);
        setPackMetaHands(obs.hands);
    }

    jw({ e: 'turn', hand: (obs.hand || []).map((c) => [c.id, c.rank, c.suit, (c.actions || []).join('/'), c.debuffed ? 'D' : '', (c.enhancements || []).concat(c.key && c.key !== 'c_base' ? [c.key] : [], c.values && c.values.type ? [`t:${c.values.type}`] : [], c.seal ? [`S:${c.seal}`] : [], (c.values && c.values.seal) ? [`S:${c.values.seal}`] : []).join('|')]), chips: obs.run.chips, epoch: obs.epoch, dl: obs.run.discards_left ?? null, hl: obs.run.hands_left ?? null, jk: (obs.jokers || []).map((j) => [j.name, j.value ?? null, j.extra ?? null, j.values ?? null]), rerolls: obs.run.rerolls_left ?? obs.run.rerolls ?? null });
    const t = await playTurn(obs, ctx.st);

    t.nullCards = (obs.hand || []).filter((c) => !c.rank).length;
    jw({ e: 'decide', a: t.action, fam: t.fam, pred: t.pred, rem: t.rem, n: t.n, ante: obs.run?.ante, stk: obs.run?.stake ?? ctx.stake, b: obs.run?.blind?.name, tgt: obs.run?.blind?.target ?? null, rchips: t.r && t.r.ok ? (t.r.result.run?.chips || before) : null, err: t.r && !t.r.ok ? t.r.error?.code : null, ef: Object.keys(bank.eyeFams || {}).join('/'), lk: bank.lockFam || '', enh: (obs.hand || []).filter((c) => (c.enhancements || []).some((e) => e && e !== 'base') || (c.key && c.key !== 'c_base')).length, sla: (obs.hand || []).map((c) => c.seal || (c.values && c.values.seal) || '').filter(Boolean).join('/'), cids: (t.cards || []).map((c) => c.id).join('.'), sids: (t.scoring || []).map((c) => c.id).join('.') });

    if (t.r?.ok && t.action === 'play' && t.fam) {
        ctx.runStats.fams[t.fam] = (ctx.runStats.fams[t.fam] || 0) + 1;
    }

    const dp = deckProbe(obs);

    if (dp) {
        jw({ e: 'deckprobe', areas: dp });
    }

    if (t.r && !t.r.ok) {
        say('turn err', t.r.error?.code);

        /* ZOMBIE-PAUSE ESCAPE (a8 Bell win rescue 10-29): game rejects every
           in-hand action while phase/overlay/ready all look clean; only a real
           Escape key wakes it. Three consecutive turn failures = stuck, not
           an epoch race — nudge over CDP; the overlay handler does Back-next */
        if (++turnErrStreak >= 3) {
            jw({ e: 'unstick', code: t.r.error?.code, streak: turnErrStreak });
            await nudgeUnpause();
            turnErrStreak = 0;
        }

        await sleep(1_500);
        const again = await observe();

        if ((again.phase || '') !== 'hand') {
            return { obs, turnErrStreak };
        }
    } else if (t.r && t.action === 'play') {
        const afterC = t.r.result.run?.chips ?? null;
        // real per-hand delta only when both ends observed the same live blind (after < before => blind transitioned)
        const d = before !== null && afterC !== null && afterC >= before ? afterC - before : null;
        /* no chips field: fall back to prediction estimate. Exception: Cerulean-Bell all-face-down hands score
           nothing and the observed null-rank hand proves the play never scored — don't bank phantoms. */
        const phantom = d === 0 && t.nullCards > 0;
        /* HONEST-SCALE BANKING (Mark med .58 / Fish .56 post-pEff: gate scale was
           shipped but the bank kept folding raw preds -> 2x phantom overshoot ->
           resync->0 every fd blind, needMore fed by fiction): credit face-down
           plays at the same 0.6 pEff factor from the SAME evidence (EV medians
           .56-.62 of raw pred), so resync fires on reality */
        let credit = d !== null ? d : t.pred;

        if (d === null && t.nullCards > 0) {
            credit = (t.pred ?? 0) * 0.6;
        }

        // face-down (Fish/Mark) hands score under guessed fams — never fold their deltas into jokerFactor
        /* The Flint now halved in predict, but rounding of the halved base is
           still guessed — keep skipping its calibration until a live Flint run
           matches; The Arm debuffs played-hand LEVELS mid-blind (build text),
           whose table reflection is unverified: fold neither into jokerFactor */
        if (d !== null && d > 0 && t.scoring && t.scoring.length && t.nullCards === 0 && !/flint|the arm/i.test(t.boss || '')) {
            const b = famBase(obs.hands, t.fam);

            calibrate(t.fam, t.scoring, b.chips, b.mult, d, { ...(t.preCtx ?? ctxOf(obs)), played: t.cards, lvl: b.level });
        }

        if (!phantom) {
            bank.pred = afterC !== null ? afterC : bank.pred + credit;
            bank.byFam[t.fam] = (bank.byFam[t.fam] || 0) + credit;
        }

        if (phantom) {
            jw({ e: 'phantom', fam: t.fam, pred: t.pred });
        }
    }

    if (t.r?.ok) {
        turnErrStreak = 0;
    }

    return { obs, turnErrStreak };
}

export { handleHand, playTurn };
