/* Selftest chunk: Reps, Card Sharp counters, calibration division (split from the monolith 10-29; run via selftest.mjs). */
import { C, tabHC } from './support.mjs';

/**
 * Reps, Card Sharp counters, calibration division assertions; throws on first failure.
 */
export async function runCalibration() {
    const { predict, calibrate, ctxOf, allSubsetEvals, chooseDiscard, resetRoundReps, syncReps, getRoundReps, resetSeen, seenN } = await import('../lib/play.mjs');
    const { jokerFactor, jokerSig } = await import('../lib/knowledge.mjs');

    /* Card Sharp: X3 only when the game's cumulative counters show the fam already
       played this blind; reps are DERIVED (syncReps diff vs blind-start baseline),
       reset = new blind. jokerFactor isolated so asserts test the model, not EMA leaks */
    resetRoundReps();

    const csJokers = [{ name: 'Card Sharp', values: { x_mult: 1, extra: { Xmult: 3 } } }];
    const savedPF = jokerFactor.Pair;

    delete jokerFactor.Pair;

    /**
     * Fresh Card Sharp prediction context (pl snapshot taken at call time).
     *
     * @returns {object} ctx for predict/calibrate
     */
    const freshCs = () => ctxOf({ jokers: csJokers, run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], freshCs()).score !== 15) {
        throw new Error('card sharp must not fire before repeat');
    }

    syncReps([{ name: 'High Card', played: 2 }, { name: 'Pair', played: 5 }]);

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], freshCs()).score !== 15) {
        throw new Error('baseline seeding must not count pre-blind plays');
    }

    syncReps([{ name: 'High Card', played: 3 }, { name: 'Pair', played: 5 }]);

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], freshCs()).score !== 45) {
        throw new Error(`card sharp X3 must fire on counter repeat ${predict(tabHC, 'High Card', [C('K', 'Hearts')], freshCs()).score}`);
    }

    if (predict(tabHC, 'Pair', [C('K', 'Hearts'), C('K', 'Spades')], freshCs()).score !== 60) {
        throw new Error(`card sharp must stay off for non-repeated families ${predict(tabHC, 'Pair', [C('K', 'Hearts'), C('K', 'Spades')], freshCs()).score}`);
    }

    syncReps([{ name: 'High Card', played: 5 }, { name: 'Pair', played: 5 }]);

    if (getRoundReps()['High Card'] !== 3 || getRoundReps().Pair !== 0) {
        throw new Error(`reps must equal counter minus baseline: ${JSON.stringify(getRoundReps())}`);
    }

    syncReps(undefined);
    syncReps([]);

    if (getRoundReps()['High Card'] !== 3) {
        throw new Error('missing hands table must never clobber derived state');
    }

    resetRoundReps();

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], freshCs()).score !== 15) {
        throw new Error('resetRoundReps must clear the X3 trigger');
    }

    syncReps([{ name: 'High Card', played: 5 }]);

    if ((getRoundReps()['High Card'] ?? 0) !== 0) {
        throw new Error('re-seed after reset must ignore pre-blind history');
    }

    /* calibration divides by the PRE-play model: first occurrence (no X3 yet) scores
       15 and trains clean; a repeat with X3 modeled trains on the real ratio */
    const savedHF = jokerFactor['High Card'];

    delete jokerFactor['High Card'];
    resetRoundReps();
    syncReps([{ name: 'High Card', played: 1 }]);
    calibrate('High Card', [C('K', 'Hearts')], 5, 1, 15, freshCs());

    if (Math.abs((jokerFactor['High Card'] ?? 1) - 1) > 1e-9) {
        throw new Error(`first occurrence must calibrate clean with pre-play ctx, got ${jokerFactor['High Card']}`);
    }

    delete jokerFactor['High Card'];
    syncReps([{ name: 'High Card', played: 2 }]);
    calibrate('High Card', [C('K', 'Hearts')], 5, 1, 15, freshCs());

    if (Math.abs((jokerFactor['High Card'] ?? 1) - 0.333_333_333_333_333_3) > 1e-9) {
        throw new Error(`repeat with X3 modeled must train 15/45=1/3, got ${jokerFactor['High Card']}`);
    }

    delete jokerFactor['High Card'];
    calibrate('High Card', [C('K', 'Hearts')], 5, 1, 45, freshCs());

    if (Math.abs((jokerFactor['High Card'] ?? 1) - 1) > 1e-9) {
        throw new Error(`X3-actual repeat must calibrate clean at 45, got ${jokerFactor['High Card']}`);
    }

    if (savedHF === undefined) {
        delete jokerFactor['High Card'];
    } else {
        jokerFactor['High Card'] = savedHF;
    }

    if (savedPF === undefined) {
        delete jokerFactor.Pair;
    } else {
        jokerFactor.Pair = savedPF;
    }

    const stenCtx = ctxOf({ jokers: [{ name: 'Joker Stencil', values: { x_mult: 4 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], stenCtx).mult !== 4) {
        throw new Error(`stencil observed x_mult is already live, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], stenCtx).mult}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Misprint', values: { extra: { max: 23, min: 0 } } }], run: { discards_left: 1 }, hands: [] })).mult !== 12.5) {
        throw new Error('misprint expected-value mult must apply');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Misprint', values: { extra: { max: 23, min: 0 } } }], run: { discards_left: 1 }, hands: [] })).unc !== true) {
        throw new Error('misprint row must be marked uncertain');
    }

    jokerFactor.TwoPair = 100;
    calibrate('Two Pair', [C('K', 'Hearts'), C('K', 'Spades'), C('9', 'Hearts'), C('9', 'Spades')], 24, 2, 9_999, ctxOf({ jokers: [{ name: 'Misprint', values: { extra: { max: 23, min: 0 } } }], run: { discards_left: 3 }, hands: [] }));

    if (jokerFactor.TwoPair !== 100) {
        throw new Error('misprint rows must not train jokerFactor');
    }

    delete jokerFactor.TwoPair;

    const trouCtx = ctxOf({ jokers: [{ name: 'Spare Trousers', values: { mult: 2, extra: 2 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], trouCtx).mult !== 3) {
        throw new Error(`spare trousers store mult must apply, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], trouCtx).mult}`);
    }

    for (const k of Object.keys(jokerFactor)) {
        delete jokerFactor[k];
        delete jokerSig[k];
    }

    const tpC = [C('K', 'Hearts'), C('K', 'Spades'), C('9', 'Hearts'), C('9', 'Spades')];
    const tpT = predict(tabHC, 'Two Pair', tpC, trouCtx);

    if (tpT.mult !== 6 || tpT.chips !== 58) {
        throw new Error(`spare trousers pending increment must apply to two pair, got ${tpT.mult}/${tpT.chips}`);
    }

    const prC = [C('K', 'Hearts'), C('K', 'Spades')];
    const prT = predict(tabHC, 'Pair', prC, trouCtx);

    if (prT.mult !== 4 || prT.chips !== 30) {
        throw new Error(`spare trousers must not increment on pair, got ${prT.mult}/${prT.chips}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Chaos the Clown', values: { extra: 1 } }], run: { discards_left: 1 }, hands: [] })).mult !== 1) {
        throw new Error('random-event joker must stay unmodeled');
    }

    const fdHand = [
        { id: 71, rank: null, suit: null, actions: ['select'] },
        { id: 72, rank: null, suit: null, actions: ['select'] },
        { ...C('K', 'Hearts'), id: 73 },
        { ...C('10', 'Spades'), id: 74 },
        { ...C('3', 'Clubs'), id: 75 },
    ];

    const o5fd = allSubsetEvals(fdHand, tabHC, null).find((o) => o.cards.length === 5 && o.cards.filter((c) => c.faceDown).length >= 2);
    const raw5 = predict(tabHC, o5fd.fam, o5fd.scoring).score;

    if (!(o5fd && o5fd.pred === Math.round(raw5 * 0.3) && o5fd.util === o5fd.pred)) {
        throw new Error('face-down subset must be EV-discounted in pred AND util (measured 0.20-0.41 on Mark)');
    }

    if (!allSubsetEvals(fdHand, tabHC, null).some((o) => o.cards.length === 2 && o.cards.filter((c) => c.faceDown).length === 1 && o.util === o.pred)) {
        throw new Error('lone face-down must keep full credit');
    }

    jokerFactor.Pair = 100;
    calibrate('Pair', [{ rank: 'K', suit: 'Hearts', faceDown: true }, { rank: 'K', suit: 'Spades', faceDown: true }], 10, 2, 9_999, ctxOf({ jokers: [], run: { discards_left: 3 }, hands: [] }));

    if (jokerFactor.Pair !== 100) {
        throw new Error('face-down rows must not train jokerFactor');
    }

    delete jokerFactor.Pair;

    const dSp = { id: 91, rank: '2', suit: 'Spades', actions: ['select'], debuffed: true };
    const liveS = [C('6', 'Spades'), C('5', 'Spades'), C('4', 'Spades'), C('A', 'Spades')];
    const evP = allSubsetEvals([...liveS, dSp, C('9', 'Hearts'), C('3', 'Clubs')], tabHC, null);
    const deadFlush = evP.find((o) => o.fam === 'Flush');

    if (!deadFlush || deadFlush.cards.length !== 5 || deadFlush.pred !== 244) {
        throw new Error(`debuffed card must classify flush with zero chips ${deadFlush && deadFlush.pred}`);
    }

    if (predict(tabHC, 'Flush', [...liveS, dSp]).chips !== predict(tabHC, 'Flush', liveS).chips) {
        throw new Error('debuffed card added chips');
    }

    const dumpHand = [C('9', 'Hearts'), C('8', 'Diamonds'), C('7', 'Clubs'), C('3', 'Hearts'), C('9', 'Spades'), C('2', 'Diamonds')].map((c, i) => ({ ...c, id: 80 + i })).concat([dSp]);

    if (chooseDiscard(dumpHand, null, null)[0].id !== 91) {
        throw new Error('discard must dump debuffed card before low live junk');
    }

    /* BLUE JOKER (B2): +2 chips per never-drawn copy; unseen counts manifest copies
       minus copies simultaneously seen - held cards are drawn, so NOT unseen */
    resetSeen();
    const blueCtx = ctxOf({
        jokers: [{ name: 'Blue Joker', values: { extra: 2 } }],
        run: {},
        hands: [],
        deck: { composition: [['K', 'Hearts', 'c_base', '', '', 1], ['Q', 'Spades', 'c_base', '', '', 2], ['7', 'Clubs', 'c_base', '', '', 1]] },
        hand: [C('K', 'Hearts'), C('Q', 'Spades')],
    });

    if (blueCtx.unseen !== 2 || seenN() !== 2) {
        throw new Error(`unseen must subtract drawn copies from manifest counts, got ${blueCtx.unseen}/${seenN()}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], blueCtx).chips - predict(tabHC, 'High Card', [C('K', 'Hearts')], { ...blueCtx, unseen: 0 }).chips !== 4) {
        throw new Error('Blue Joker must add extra x unseen chips');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], { ...blueCtx, unseen: null }).chips !== predict(tabHC, 'High Card', [C('K', 'Hearts')], { ...blueCtx, unseen: 0 }).chips) {
        throw new Error('unknown deck must leave Blue unpriced, not guessed');
    }

    resetSeen();
}
