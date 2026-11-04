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

    /* COHORT-23 Monte-Carlo hold EV (lib/mc.mjs): count-based best-5 over 5..8 cards +
       sampled refill from the real unseen multiset */
    const { famChips, mcHold } = await import('../lib/mc.mjs');
    const { markSeen, unseenDeck } = await import('../lib/reps.mjs');

    /**
     *
     * @param rank
     * @param suit
     * @param id
     */
    const MC = (rank, suit, id) => ({ rank, suit, id, actions: ['select'] });
    const fh8 = [MC(9, 'Hearts', 1), MC(9, 'Spades', 2), MC(9, 'Diamonds', 3), MC(7, 'Hearts', 4), MC(7, 'Spades', 5), MC(2, 'Hearts', 6), MC(3, 'Hearts', 7), MC(4, 'Hearts', 8)];

    if (famChips(fh8).fam !== 'Full House' || famChips(fh8).chips !== 41) {
        throw new Error('best-5 over 8 cards must find the Full House (3x9 + 2x7, 41 scoring chips)');
    }

    if (famChips([MC(14, 'Hearts', 1), MC(2, 'Spades', 2), MC(3, 'Diamonds', 3), MC(4, 'Clubs', 4), MC(5, 'Hearts', 5)]).fam !== 'Straight') {
        throw new Error('wheel Ace-low straight must be detected');
    }

    const heartDeck = [5, 6, 8, 10, 11, 12, 13, 14, 9, 7].map((r) => ({ rank: r, suit: 'Hearts' }));

    for (let i = 0; i < 12; i++) {
        heartDeck.push({ rank: 2 + (i % 8), suit: 'Spades' });
    }

    const mctx = { udeck: heartDeck, fam: 'Flush', lvl: 3, N: 200 };
    const flushKeep = [MC(14, 'Hearts', 1), MC(13, 'Hearts', 2), MC(12, 'Hearts', 3), MC(7, 'Hearts', 4), MC(2, 'Clubs', 5)];
    const junkKeep = [MC(2, 'Clubs', 5), MC(3, 'Diamonds', 6), MC(4, 'Spades', 7), MC(5, 'Clubs', 8), MC(14, 'Hearts', 1)];
    const evF = mcHold(flushKeep, 3, mctx);
    const evJ = mcHold(junkKeep, 3, mctx);

    if (!(evF > evJ * 2)) {
        throw new Error(`flush-draw keep must dominate broken keep on a heart-rich deck, got ${Math.round(evF)} vs ${Math.round(evJ)}`);
    }

    if (mcHold(flushKeep, 3, mctx) !== evF) {
        throw new Error('MC must be deterministic (calibration folds plays against the SAME pred)');
    }

    if (mcHold(flushKeep, 3, { udeck: heartDeck.slice(0, 5), fam: 'Flush' }) !== null) {
        throw new Error('tiny/deckless multiset must return null (heuristic fallback, never guess)');
    }

    /* MC REAL SCORE (11-05 user correction: "still optimizes a heuristic, not actual
       scoring"): with the hands table the sampled value IS the printed score -
       (table chips + scoring chips) x table mult, levels truth from table rows */
    const { simVal } = await import('../lib/mc.mjs');
    const tabReal = [
        { name: 'Two Pair', chips: 240, mult: 2, level: 7 },
        { name: 'Flush', chips: 90, mult: 4, level: 1 },
        { name: 'High Card', chips: 5, mult: 1, level: 1 },
    ];
    const tp5 = [MC(13, 'Spades', 31), MC(13, 'Hearts', 32), MC(7, 'Spades', 33), MC(7, 'Hearts', 34), MC(2, 'Clubs', 35)];
    const f5 = [MC(14, 'Hearts', 36), MC(13, 'Hearts', 37), MC(12, 'Hearts', 38), MC(7, 'Hearts', 39), MC(2, 'Hearts', 40)];

    if (simVal(tp5, { ht: tabReal }) !== (240 + 34) * 2) {
        throw new Error(`real-score Two Pair must be (240+34)x2, got ${simVal(tp5, { ht: tabReal })}`);
    }

    if (simVal(tp5, { ht: tabReal }) <= simVal(f5, { ht: tabReal })) {
        throw new Error('TP L7 (480 base) must beat Flush L1 (360 base) on REAL score');
    }

    if (simVal(f5, { fam: 'Flush', lvl: 1 }) <= simVal(tp5, { fam: 'Flush', lvl: 1 })) {
        throw new Error('legacy FAMS fallback must keep the old scale (flush above TP) when tableless');
    }

    const tpSteel = tp5.map((c, i) => (i === 0 ? { ...c, enh: 'm_steel' } : c));

    if (simVal(tpSteel, { ht: tabReal }) !== (240 + 34) * 2 * 1.5) {
        throw new Error('scored Steel Card must multiply the real score by 1.5');
    }

    const tpStone = [...tp5, {
        rank: 9, suit: 'Diamonds', enh: 'm_stone', id: 41,
    }];

    if (simVal(tpStone, { ht: tabReal }) !== (240 + 34 + 50) * 2) {
        throw new Error('Stone Card must fill the 5th scoring slot for +50 chips (TRUTH semantics)');
    }

    const stFlush4 = [MC(13, 'Diamonds', 42), MC(12, 'Diamonds', 43), MC(11, 'Diamonds', 44), MC(7, 'Diamonds', 45), {
        rank: 2, suit: 'Diamonds', enh: 'm_stone', id: 46,
    }];

    if (simVal(stFlush4, { ht: tabReal }) !== (5 + 10 + 50)) {
        throw new Error('Stone Diamond must NOT complete a flush (no rank or suit truth), only add its chips');
    }

    const mcHand = [MC(14, 'Hearts', 61), MC(13, 'Hearts', 62), MC(12, 'Hearts', 63), MC(7, 'Hearts', 64), MC(2, 'Clubs', 65), MC(3, 'Diamonds', 66), MC(4, 'Spades', 67), MC(5, 'Clubs', 68)];
    const disc = chooseDiscard(mcHand, null, null, { udeck: heartDeck, fam: 'Flush', lvl: 3, hl: 3, disc: 3 });

    if (disc.some((c) => c.suit === 'Hearts') || disc.length === 0) {
        throw new Error('MC path must keep the 4-flush engine and dump only off-suit junk');
    }

    /* MC v2 hand==5: single discard IS draw EV - with a 4-flush engine + rich deck the
       rv junk-sort would dump the 2-of-hearts and break it; MC dumps the off-suit King */
    const h5 = [MC(2, 'Hearts', 71), MC(7, 'Hearts', 72), MC(9, 'Hearts', 73), MC(11, 'Hearts', 76), MC(13, 'Diamonds', 75)];
    const d5 = chooseDiscard(h5, null, null, { udeck: heartDeck, fam: 'Flush', lvl: 3, hl: 3, disc: 2 });

    if (d5.length !== 1 || d5[0].id !== 75) {
        throw new Error(`hand-5 MC discard must dump the off-suit King (id75) to keep the 4-flush, got ${JSON.stringify(d5.map((c) => c.id))}`);
    }

    resetSeen();

    const ud = unseenDeck([[14, 'Hearts', '', '', '', 1], ['Ace', 'Spades', 'm_mult', '', '', 2], [2, 'Clubs', '', '', '', 1]]);

    if (ud.length !== 4 || !ud.some((c) => c.rank === 14 && c.suit === 'Spades') || !ud.some((c) => c.rank === 2)) {
        throw new Error('unseenDeck must expand manifest counts (incl named ranks) to a joint multiset');
    }

    markSeen([{ rank: 14, suit: 'Hearts' }]);

    if (unseenDeck([[14, 'Hearts', '', '', '', 1]]).length !== 0) {
        throw new Error('seen copies must leave the drawable multiset');
    }

    resetSeen();
}
