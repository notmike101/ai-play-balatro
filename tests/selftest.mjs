/* driver selftest suite — extracted verbatim from driver.mjs (10-29, behavior-identical); run via `node driver.mjs --selftest`. */
import { resetRoundReps, syncReps, getRoundReps } from '../lib/play.mjs';
import { planetFam, nextPlanetNeed } from '../lib/shop.mjs';
import { chooseStrategy, famBiasMap, planTargeted, gateAllows, scorePackOffer } from '../lib/strategy.mjs';
import { jokerFactor, jokerSig, JUNK_JOKER } from '../lib/knowledge.mjs';

/**
 * Run every policy/evaluator assertion; throws on first failure.
 */
export async function runSelftest() {
    const { evalHand } = await import('../lib/eval.mjs');
    const { predict, calibrate, knownLayer, ctxOf, allSubsetEvals, chooseDiscard } = await import('../lib/play.mjs');
    /**
     * Build a minimal selectable card for the evaluator selftest.
     *
     * @param {string} rank - card rank label
     * @param {string} suit - card suit label
     * @returns {object} card-like object with a select action
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- local card fixture builder
    const C = (rank, suit) => ({ rank, suit, actions: ['select'] });
    /**
     * Assert evalHand maps the given card pairs to the expected hand family.
     *
     * @param {string[][]} f - [rank, suit] pairs
     * @param {string} m - expected hand family name
     */
    const a = (f, m) => {
        const got = evalHand(f.map(([r, s]) => C(r, s)));

        if (got.fam !== m) {
            throw new Error(`eval ${m} got ${got.fam} for ${JSON.stringify(f)}`);
        }
    };

    a([['Ace', 'Hearts'], ['King', 'Hearts'], ['Queen', 'Hearts'], ['Jack', 'Hearts'], ['10', 'Hearts']], 'Straight Flush');
    a([['9', 'Hearts'], ['8', 'Hearts'], ['7', 'Hearts'], ['6', 'Hearts'], ['5', 'Hearts']], 'Straight Flush');
    a([['7', 'Hearts'], ['7', 'Spades'], ['7', 'Diamonds'], ['7', 'Clubs'], ['2', 'Hearts']], 'Four of a Kind');
    a([['8', 'Hearts'], ['8', 'Spades'], ['8', 'Diamonds'], ['3', 'Clubs'], ['3', 'Hearts']], 'Full House');
    a([['2', 'Spades'], ['5', 'Spades'], ['7', 'Spades'], ['9', 'Spades'], ['K', 'Spades']], 'Flush');
    a([['4', 'Hearts'], ['5', 'Spades'], ['6', 'Diamonds'], ['7', 'Clubs'], ['8', 'Hearts']], 'Straight');
    a([['Ace', 'Hearts'], ['2', 'Spades'], ['3', 'Diamonds'], ['4', 'Clubs'], ['5', 'Hearts']], 'Straight');
    a([['J', 'Hearts'], ['J', 'Spades'], ['J', 'Diamonds'], ['4', 'Clubs'], ['9', 'Hearts']], 'Three of a Kind');
    a([['6', 'Hearts'], ['6', 'Spades'], ['Q', 'Hearts'], ['Q', 'Diamonds'], ['2', 'Clubs']], 'Two Pair');
    a([['K', 'Hearts'], ['K', 'Spades'], ['2', 'Hearts'], ['7', 'Diamonds'], ['9', 'Clubs']], 'Pair');
    a([['K', 'Hearts'], ['3', 'Spades'], ['2', 'Hearts'], ['7', 'Diamonds'], ['9', 'Clubs']], 'High Card');
    const pred = predict([{ name: 'Flush', chips: 60, mult: 6, level: 2 }], 'Flush', [C('K', 'Spades'), C('2', 'Spades'), C('5', 'Spades'), C('7', 'Spades'), C('9', 'Spades')]);

    if (pred.score !== (60 + 10 + 2 + 5 + 7 + 9) * 6) {
        throw new Error(`predict ${pred.score}`);
    }

    if (evalHand([C('2', 'Hearts'), C('2', 'Spades')]).fam !== 'Pair') {
        throw new Error('2-card pair');
    }

    const fd = allSubsetEvals([{ rank: null, suit: null, actions: ['select'] }, { rank: null, suit: null, actions: ['select'] }, C('K', 'Hearts'), C('K', 'Spades'), C('2', 'Diamonds')], [{ name: 'Pair', chips: 10, mult: 2, level: 1 }]);

    // null-rank cards must not beat the real Kings
    if (fd[0].fam !== 'Pair' || fd[0].pred !== 60) {
        throw new Error(`facedown eval: ${fd[0].fam}/${fd[0].pred}`);
    }

    const uTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const uCards = [{ id: 1, rank: 'K', suit: 'Hearts', actions: ['select'] }, { id: 2, rank: 'K', suit: 'Spades', actions: ['select'] }];
    const uRaw = predict(uTab, 'Pair', uCards).score;
    const u = allSubsetEvals(uCards, uTab, { Pair: 2 });

    if (u[0].fam !== 'Pair' || u[0].pred !== uRaw || u[0].util !== uRaw * 2) {
        throw new Error(`util/pred split: pred=${u[0].pred} util=${u[0].util} raw=${uRaw}`);
    }

    calibrate('Pair', [C('K', 'H'), C('K', 'S')], 10, 2, 600);

    if (Math.abs(jokerFactor.Pair - 10) > 1e-9) {
        throw new Error(`cal ${jokerFactor.Pair}`);
    }

    const tabHC = [{ name: 'High Card', chips: 5, mult: 1, level: 1 }];
    const kSc = [C('K', 'Hearts')];
    const obsM0 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 0 }, hands: [] });
    const obsM3 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 3 }, hands: [] });
    const mysticOn = predict(tabHC, 'High Card', kSc, obsM0).score;
    const mysticOff = predict(tabHC, 'High Card', kSc, obsM3).score;

    if (mysticOff !== predict(tabHC, 'High Card', kSc).score || mysticOn !== mysticOff * 31) {
        throw new Error(`mystic gate/stack ${mysticOn}/${mysticOff}`);
    }

    const photo = predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Photograph' }, { name: 'Photograph' }], run: { discards_left: 1 }, hands: [] })).score;

    if (photo !== mysticOff * 4) {
        throw new Error(`photograph stacking ${photo}`);
    }

    const ancCtx = ctxOf({ jokers: [{ name: 'Ancient Joker' }], run: { discards_left: 1 }, hands: [] });
    const ancX = knownLayer('Flush', [C('2', 'Hearts'), C('5', 'Hearts'), C('7', 'Hearts'), C('9', 'Hearts'), C('J', 'Hearts')], ancCtx).xm;

    if (Math.abs(ancX - (3 + 1.5 ** 5) / 4) > 1e-9) {
        throw new Error(`ancient flush EV must stay a lottery ${ancX}`);
    }

    const ancMix = predict(tabHC, 'Flush', [C('2', 'Hearts'), C('5', 'Hearts'), C('7', 'Spades'), C('9', 'Diamonds'), C('J', 'Clubs')], ancCtx);

    if (Math.abs(ancMix.xm - (1.5 ** 2 + 3 * 1.5) / 4) > 1e-9 || ancMix.unc !== true) {
        throw new Error(`ancient mixed EV/unc ${ancMix.xm}/${ancMix.unc}`);
    }

    if (predict(tabHC, 'Flush', [C('2', 'Hearts'), C('5', 'Hearts'), C('7', 'Hearts'), C('9', 'Hearts'), C('J', 'Hearts')], ancCtx).unc !== true) {
        throw new Error('single-suit Ancient play must be marked uncertain (suit match is 1-in-4)');
    }

    const hFlush = [C('2', 'Hearts'), C('5', 'Hearts'), C('7', 'Hearts'), C('9', 'Hearts'), C('J', 'Hearts')];
    const anc2X = knownLayer('Flush', hFlush, ctxOf({ jokers: [{ name: 'Ancient Joker' }, { name: 'Ancient Joker' }], run: { discards_left: 1 }, hands: [] })).xm;

    if (Math.abs(anc2X - ((3 + 1.5 ** 5) / 4) ** 2) > 1e-9) {
        throw new Error(`two Ancient copies pick suits independently, got ${anc2X}`);
    }

    const ancKnownX = knownLayer('Flush', hFlush, ctxOf({ jokers: [{ name: 'Ancient Joker', values: { extra: { suit: 'Hearts' } } }], run: { discards_left: 1 }, hands: [] }));

    if (Math.abs(ancKnownX.xm - 1.5 ** 5) > 1e-9 || ancKnownX.unc !== false) {
        throw new Error(`observed suit must be exact and calibratable ${ancKnownX.xm}/${ancKnownX.unc}`);
    }

    const ancMissX = knownLayer('Flush', hFlush, ctxOf({ jokers: [{ name: 'Ancient Joker', values: { extra: { suit: 'Spades' } } }], run: { discards_left: 1 }, hands: [] }));

    if (ancMissX.xm !== 1 || ancMissX.unc !== false) {
        throw new Error(`observed wrong suit must be exact x1 ${ancMissX.xm}`);
    }

    const ancHalfX = knownLayer('Flush', hFlush, ctxOf({ jokers: [{ name: 'Ancient Joker', values: { extra: { suit: 'Hearts' } } }, { name: 'Ancient Joker' }], run: { discards_left: 1 }, hands: [] }));

    if (Math.abs(ancHalfX.xm - 1.5 ** 5 * (3 + 1.5 ** 5) / 4) > 1e-9 || ancHalfX.unc !== true) {
        throw new Error(`mixed known/unknown copies ${ancHalfX.xm}/${ancHalfX.unc}`);
    }

    const scaryCtx = ctxOf({ jokers: [{ name: 'Scary Face', values: { extra: 30 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('J', 'Hearts')], scaryCtx).chips !== 45) {
        throw new Error(`Scary Face must count Jack as face chip source, got ${predict(tabHC, 'High Card', [C('J', 'Hearts')], scaryCtx).chips}`);
    }

    if (predict(tabHC, 'High Card', [C('9', 'Hearts')], scaryCtx).chips !== 14) {
        throw new Error(`Scary Face fired on non-face card`);
    }

    if (predict(tabHC, 'High Card', [{ rank: 'K', suit: 'Hearts', actions: ['select'], debuffed: true }], scaryCtx).chips !== 5) {
        throw new Error('Scary Face fired on debuffed face card');
    }

    const abCtx = ctxOf({
        jokers: [
            { name: 'Abstract Joker', values: { extra: 3 } },
            { name: 'Green Joker', values: { mult: 2, extra: { discard_sub: 1, hand_add: 1 } } },
            { name: 'Joker' },
            { name: 'Joker' },
            { name: 'Joker' },
        ],
        run: { discards_left: 1 },
        hands: [],
    });

    if (predict(tabHC, 'High Card', kSc, abCtx).score !== mysticOff * 19) {
        throw new Error(`Abstract 3x5 jokers + Green mult2+hand_add1 must give x19, got ${predict(tabHC, 'High Card', kSc, abCtx).score}`);
    }

    const fibC = [C('A', 'Hearts'), C('K', 'Hearts')];
    const fibP = predict(tabHC, 'High Card', fibC, ctxOf({ jokers: [{ name: 'Fibonacci' }, { name: 'Fibonacci' }], run: { discards_left: 1 }, hands: [] })).score;
    const fibNone = predict(tabHC, 'High Card', fibC).score;

    if (fibP !== fibNone * 17) {
        throw new Error(`fibonacci mult stack ${fibP}/${fibNone}`);
    }

    if (predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Fibonacci' }], run: { discards_left: 1 }, hands: [] })).score !== mysticOff) {
        throw new Error('fibonacci fired on non-fib rank');
    }

    const snova = predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Supernova' }], run: { discards_left: 1 }, hands: [{ name: 'High Card', played: 4 }] })).score;

    if (snova !== mysticOff * 6) {
        throw new Error(`supernova current-play off-by-one ${snova}`);
    }

    const madCtx = ctxOf({ jokers: [{ name: 'Mad Joker', values: { type: 'High Card', t_mult: 10 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', kSc, madCtx).score !== mysticOff * 11) {
        throw new Error(`mad joker t_mult must be exact ${predict(tabHC, 'High Card', kSc, madCtx).score}`);
    }

    const kPair = [C('K', 'Hearts'), C('K', 'Spades')];
    const plainMadCtx = ctxOf({ jokers: [{ name: 'Mad Joker' }], run: { discards_left: 1 }, hands: [] });

    /* same joker NAME both sides (identical lineup sig cancels the residual factor
       gate exactly) - only the t_mult state differs, isolating the family gate */
    if (predict(tabHC, 'Pair', kPair, madCtx).score !== predict(tabHC, 'Pair', kPair, plainMadCtx).score) {
        throw new Error('mad joker fired on wrong family');
    }

    /* lineup-churn gate: a trained residual factor must apply ONLY under the lineup it
       was learned under (over-pred 1.29x/1.4x runs 1793030565+0566: TP factor learned
       before Saturn buys kept scaling new lineups) */
    jokerFactor['High Card'] = 3;
    jokerSig['High Card'] = 'Ghost:1';

    const churnA = ctxOf({ jokers: [{ name: 'Ghost' }], run: { discards_left: 1 }, hands: [] });
    const churnB = ctxOf({ jokers: [{ name: 'Ghost' }, { name: 'Baron' }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', kSc, churnB).score * 3 !== predict(tabHC, 'High Card', kSc, churnA).score) {
        throw new Error(`factor must scale matching lineup only, A=${predict(tabHC, 'High Card', kSc, churnA).score} B=${predict(tabHC, 'High Card', kSc, churnB).score}`);
    }

    delete jokerFactor['High Card'];
    delete jokerSig['High Card'];

    const wrathCtx = ctxOf({ jokers: [{ name: 'Wrathful Joker', values: { extra: { s_mult: 6, suit: 'Hearts' } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', kSc, wrathCtx).score !== mysticOff * 7) {
        throw new Error(`wrathful suit mult must be exact ${predict(tabHC, 'High Card', kSc, wrathCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Spades')], wrathCtx).score !== mysticOff) {
        throw new Error('wrathful fired on wrong suit');
    }

    const banCtx = ctxOf({ jokers: [{ name: 'Banner', values: { extra: 30 } }], run: { discards_left: 3 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], banCtx).score !== 105) {
        throw new Error(`banner +30/discards-left must be exact ${predict(tabHC, 'High Card', [C('K', 'Hearts')], banCtx).score}`);
    }

    const schCtx = ctxOf({ jokers: [{ name: 'Scholar', values: { extra: { chips: 6, mult: 2 } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('A', 'Hearts'), C('K', 'Hearts')], schCtx).score !== 96) {
        throw new Error(`scholar ace chips+mult must be exact ${predict(tabHC, 'High Card', [C('A', 'Hearts'), C('K', 'Hearts')], schCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], schCtx).score !== mysticOff) {
        throw new Error('scholar fired on non-ace');
    }

    const toddCtx = ctxOf({ jokers: [{ name: 'Odd Todd', values: { extra: 1 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('10', 'Spades'), C('A', 'Hearts')], toddCtx).chips !== 27) {
        throw new Error(`odd-todd odd-rank chips must be exact ${predict(tabHC, 'High Card', [C('10', 'Spades'), C('A', 'Hearts')], toddCtx).chips}`);
    }

    const stevCtx = ctxOf({ jokers: [{ name: 'Even Steven', values: { extra: 1 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('2', 'Spades'), C('4', 'Hearts')], stevCtx).score !== 33) {
        throw new Error(`even-steven even-rank mult must be exact ${predict(tabHC, 'High Card', [C('2', 'Spades'), C('4', 'Hearts')], stevCtx).score}`);
    }

    const vampCtx = ctxOf({ jokers: [{ name: 'Vampire', values: { x_mult: 1.4, extra: 0.1 } }], run: { discards_left: 1 }, hands: [] });
    const enhK = [{ ...C('K', 'Hearts'), key: 'm_bonus' }, { ...C('K', 'Spades'), enhancements: ['Steel'] }, C('K', 'Clubs')];

    if (Math.abs(predict(tabHC, 'High Card', enhK, vampCtx).mult - 1.6) > 1e-9) {
        throw new Error(`vampire store+pending enhanced must give x1.6, got ${predict(tabHC, 'High Card', enhK, vampCtx).mult}`);
    }

    const popv = { bonus: 0, d_size: 0, extra: 4, h_size: 0, mult: 20, perma_bonus: 0, t_chips: 0, t_mult: 0, type: '', x_mult: 1 };

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Popcorn', values: popv }], run: { discards_left: 1 }, hands: [] })).score !== 315) {
        throw new Error('popcorn mult store must be exact');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Ice Cream', values: { extra: { chip_mod: 5, chips: 100 } } }], run: { discards_left: 1 }, hands: [] })).score !== 115) {
        throw new Error('ice cream chips store must be exact');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Gros Michel', values: { extra: { mult: 15, mult_mod: 1 } } }], run: { discards_left: 1 }, hands: [] })).score !== 240) {
        throw new Error('gros michel mult store must be exact');
    }

    const wtCtx = ctxOf({ jokers: [{ name: 'Walkie Talkie', values: { extra: { chips: 10, mult: 4 } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts'), C('Q', 'Spades')], wtCtx).score !== 25) {
        throw new Error(`walkie talkie must not fire on K/Q ${predict(tabHC, 'High Card', [C('K', 'Hearts'), C('Q', 'Spades')], wtCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('10', 'Hearts'), C('4', 'Spades')], wtCtx).score !== 351) {
        throw new Error(`walkie talkie 10/4 store must be exact ${predict(tabHC, 'High Card', [C('10', 'Hearts'), C('4', 'Spades')], wtCtx).score}`);
    }

    const smyCtx = ctxOf({ jokers: [{ name: 'Smiley Face', values: { extra: 5 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('J', 'Hearts'), C('9', 'Spades')], smyCtx).score !== 144) {
        throw new Error(`smiley face per-face mult must apply ${predict(tabHC, 'High Card', [C('J', 'Hearts'), C('9', 'Spades')], smyCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('9', 'Hearts'), C('7', 'Spades')], smyCtx).score !== 21) {
        throw new Error(`smiley face must not fire without face ${predict(tabHC, 'High Card', [C('9', 'Hearts'), C('7', 'Spades')], smyCtx).score}`);
    }

    const obeCtx = ctxOf({ jokers: [{ name: 'Obelisk', values: { x_mult: 3 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], obeCtx).score !== 45) {
        throw new Error(`obelisk live x_mult must apply ${predict(tabHC, 'High Card', [C('K', 'Hearts')], obeCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Joker', values: { mult: 4 } }], run: { discards_left: 1 }, hands: [] })).score !== 75) {
        throw new Error('plain joker static mult must apply');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Blue Joker', values: { extra: 2 } }], run: { discards_left: 1 }, hands: [] })).score !== 15) {
        throw new Error('blue joker must stay unmodeled without deck state');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Constellation', values: { x_mult: 3 } }], run: { discards_left: 1 }, hands: [] })).score !== 45) {
        throw new Error('constellation live x_mult must apply');
    }

    const gCtx = ctxOf({ jokers: [{ name: 'Greedy Joker', values: { extra: { s_mult: 3, suit: 'Diamonds' } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('5', 'Diamonds')], gCtx).score !== 40) {
        throw new Error(`greedy suit mult must apply ${predict(tabHC, 'High Card', [C('5', 'Diamonds')], gCtx).score}`);
    }

    if (predict(tabHC, 'High Card', [C('5', 'Hearts')], gCtx).score !== 10) {
        throw new Error('greedy must ignore non-diamond cards');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], ctxOf({ jokers: [{ name: 'Oops! All 6s', values: { x_mult: 1 } }], run: { discards_left: 1 }, hands: [] })).unc !== false) {
        throw new Error('oops all 6s must not mark scores uncertain');
    }

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

    const tHand = [
        { id: 1, rank: 'K', suit: 'Hearts', actions: ['select'] },
        { id: 2, rank: 'Q', suit: 'Spades', actions: ['select'] },
        { id: 3, rank: '2', suit: 'Clubs', actions: ['select'] },
        { id: 4, rank: '7', suit: 'Diamonds', actions: ['select'] },
    ];
    /**
     * One tarot consumable fixture for the plan selftest.
     *
     * @param {string} name - tarot display name
     * @returns {object[]} consumable list
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- local tarot fixture builder
    const tCons = (name) => [{ id: 't1', kind: 'tarot', name, actions: ['use'] }];
    const tpCases = [
        ['The Magician', tHand, [1, 2]],
        ['The Empress', tHand, [1, 2]],
        ['The Hierophant', tHand, [1, 2]],
        ['The Tower', tHand, [3]],
        ['The Devil', tHand, [3]],
        ['Chariot', tHand, [1]],
        ['Justice', tHand, [1]],
        ['The Lovers', tHand, [1]],
        ['Strength', tHand, [1]],
        ['The Hanged Man', tHand, [4, 3]],
        ['The Star', tHand, [3, 2, 1]],
        ['The Moon', tHand, [4, 2, 1]],
        ['The Sun', tHand, [3, 4, 2]],
        ['The World', tHand, [3, 4, 1]],
    ];

    if (planTargeted({ hand: tHand, consumables: tCons('The Star') }, { Hearts: 5 }).length !== 0) {
        throw new Error('non-committed-suit converter must be skipped');
    }

    if (planTargeted({ hand: tHand, consumables: tCons('The Sun') }, { Hearts: 5 }).length !== 1) {
        throw new Error('committed-suit converter must fire');
    }

    for (const [nm, hand, want] of tpCases) {
        const p = planTargeted({ hand, consumables: tCons(nm) });

        if (p.length !== 1 || p[0].cards.map((x) => x.id).join() !== want.join()) {
            throw new Error(`tarot ${nm}: want ${want} got ${JSON.stringify(p[0] && p[0].cards.map((x) => x.id))}`);
        }
    }

    const tpNoUse = planTargeted({ hand: tHand, consumables: [{ id: 't2', kind: 'Tarot', name: 'The Empress', actions: ['sell', 'inspect'], face_down: false }] });

    if (tpNoUse.length !== 1) {
        throw new Error('held targeted tarot without use action must still plan (select enables it)');
    }

    const pdFallback = planTargeted({ hand: tHand, consumables: tCons('Death') });

    if (pdFallback.length !== 1 || pdFallback[0].cards.map((x) => x.id).join() !== '3,4') {
        throw new Error(`death must fall back to best right-with-weaker-left pair when best is leftmost, got ${JSON.stringify(pdFallback[0] && pdFallback[0].cards.map((x) => x.id))}`);
    }

    const tDesc = [
        { id: 21, rank: 'K', suit: 'Hearts', actions: ['select'] },
        { id: 22, rank: 'Q', suit: 'Hearts', actions: ['select'] },
        { id: 23, rank: '7', suit: 'Hearts', actions: ['select'] },
        { id: 24, rank: '6', suit: 'Spades', actions: ['select'] },
        { id: 25, rank: '4', suit: 'Diamonds', actions: ['select'] },
        { id: 26, rank: '2', suit: 'Spades', actions: ['select'] },
        { id: 27, rank: '2', suit: 'Hearts', actions: ['select'] },
    ];
    const pDesc = planTargeted({ hand: tDesc, consumables: tCons('Death') });

    if (pDesc.length !== 1 || pDesc[0].cards.map((x) => x.id).join() !== '25,27') {
        throw new Error(`death on a rank-descending hand must demote the cheapest higher card (4d id25) into the duplicate rank anchor 2h id27, got ${JSON.stringify(pDesc[0] && pDesc[0].cards.map((x) => x.id))}`);
    }

    const jkp = planTargeted({ hand: tHand, consumables: tCons('The Lovers'), jokers: [{ id: 'j1', name: 'Blueprint', score: 900 }, { id: 'j2', name: 'Joker', score: 40 }] });

    if (jkp.length !== 1 || jkp[0].jid !== 'j1' || !/^jkcopy The Lovers/.test(jkp[0].why)) {
        throw new Error(`Lovers must plan a joker-copy onto the top scorer, got ${JSON.stringify(jkp)}`);
    }

    const jkSolo = planTargeted({ hand: tHand, consumables: tCons('The Lovers'), jokers: [{ id: 'j1', name: 'Blueprint', score: 900 }] });

    if (jkSolo.length !== 0 && String(jkSolo[0].why).startsWith('jkcopy')) {
        throw new Error('Lovers must not plan a joker-copy while no slot can gain from it (needs >=2 jokers)');
    }

    const handFlushSteel = [
        { id: 11, rank: 'K', suit: 'Hearts', actions: ['select'] },
        { id: 12, rank: 'Q', suit: 'Spades', actions: ['select'] },
        { id: 13, rank: 'J', suit: 'Spades', actions: ['select'] },
        { id: 14, rank: '9', suit: 'Spades', actions: ['select'] },
        { id: 15, rank: '2', suit: 'Spades', actions: ['select'] },
    ];
    const pSteel = planTargeted({ hand: handFlushSteel, consumables: tCons('Justice') });

    if (pSteel.length !== 1 || pSteel[0].cards[0].id !== 12 || pSteel[0].why !== 'enhance best flushsuit') {
        throw new Error(`steel must enhance flush-suit best (Q Spades) not off-suit K, got ${JSON.stringify(pSteel[0] && [pSteel[0].cards[0].id, pSteel[0].why])}`);
    }

    const pPlainBest = planTargeted({ hand: handFlushSteel, consumables: tCons('Strength') });

    if (pPlainBest.length !== 1 || pPlainBest[0].cards[0].id !== 11) {
        throw new Error('non-steel best1 keeps plain rank order');
    }

    const tHand2 = [tHand[1], tHand[0], tHand[2], tHand[3]];
    const pd = planTargeted({ hand: tHand2, consumables: tCons('Death') });

    if (pd.length !== 1 || pd[0].cards[0].id !== 2 || pd[0].cards[1].id !== 1) {
        throw new Error(`death needs [leftSacrifice,best], got ${JSON.stringify(pd[0] && pd[0].cards.map((x) => x.id))}`);
    }

    if (!gateAllows('always', {}, 0, 1, false, false) || !gateAllows('slot', {}, 0, 1, false, true) || gateAllows('slot', {}, 0, 1, false, false)) {
        throw new Error('gate always/slot broken');
    }

    if (gateAllows('rich', {}, 0, 1, false, true) || !gateAllows('rich', {}, 5, 1, false, true) || !gateAllows('poor', {}, 10, 1, false, true) || gateAllows('hand', {}, 5, 1, false, true)) {
        throw new Error('gate rich/poor/hand broken');
    }

    const stHands = ['High Card', 'Pair', 'Flush'].map((name) => ({ name, level: 1, played: 0 }));
    const stTie = chooseStrategy({ hands: stHands, jokers: [], consumables: [] });

    if (stTie.fam !== null) {
        throw new Error(`tie must yield null family, got ${stTie.fam}`);
    }

    const stBias = famBiasMap(stTie, { hands: stHands });

    if (Object.values(stBias).some((v) => v !== 1)) {
        throw new Error(`no-signal bias must be all 1, got ${JSON.stringify(stBias)}`);
    }

    stHands[1].played = 1;
    const stSig = chooseStrategy({ hands: stHands, jokers: [], consumables: [] });

    if (stSig.fam !== 'Pair' || famBiasMap(stSig, { hands: stHands }).Pair !== 1.25) {
        throw new Error(`played=1 signal must pick Pair with bias 1.25, got ${JSON.stringify(stSig)}`);
    }

    const CANON = { Pluto: 'High Card', Mercury: 'Pair', Uranus: 'Two Pair', Venus: 'Three of a Kind', Saturn: 'Straight', Jupiter: 'Flush', Earth: 'Full House', Mars: 'Four of a Kind', Neptune: 'Straight Flush' };

    for (const [p, f] of Object.entries(CANON)) {
        if (planetFam({ name: p, effect: [] }) !== f) {
            throw new Error(`planet table rotated: ${p} must level ${f}, got ${planetFam({ name: p, effect: [] })}`);
        }
    }

    /* planet targeting (window forensics d1/d2): levels follow GRINDABLE play,
       never unplayable fams, no pre-evidence junk, no target = null = no purchase */
    const hp = [{ name: 'Two Pair', level: 1, played: 2 }, { name: 'High Card', level: 1, played: 0 }];

    if (nextPlanetNeed(hp)?.f !== 'Two Pair') {
        throw new Error(`maxP>=2 must target most-played grindable, got ${JSON.stringify(nextPlanetNeed(hp))}`);
    }

    if (nextPlanetNeed([{ name: 'Straight Flush', level: 1, played: 3 }, { name: 'Pair', level: 1, played: 1 }]) !== null) {
        throw new Error('SF-led play with <2 grindable plays must NOT target the unplayable fam');
    }

    if (nextPlanetNeed([{ name: 'Flush', level: 5, played: 9 }, { name: 'Straight Flush', level: 3, played: 0 }, { name: 'Pair', level: 1, played: 3 }])?.f !== 'Flush') {
        throw new Error(`maxP over grindable fams must win, got ${JSON.stringify(nextPlanetNeed([{ name: 'Flush', level: 5, played: 9 }, { name: 'Straight Flush', level: 3, played: 0 }, { name: 'Pair', level: 1, played: 3 }]))}`);
    }

    if (nextPlanetNeed([{ name: 'Flush', level: 9, played: 9 }, { name: 'Straight Flush', level: 3, played: 0 }, { name: 'Pair', level: 1, played: 3 }]) !== null) {
        throw new Error('maxed most-played fam must yield null (level 9 buys nothing), not SF filler');
    }

    if (!JUNK_JOKER.test('Madness') || JUNK_JOKER.test('Madder Hall')) {
        throw new Error('Madness must be junk (ate Walkie Talkie + Blue Joker inside two blinds, run 1793029490 died 544 short of small) and its anchored-mad fix must not sweep Madder Hall');
    }

    if (scorePackOffer({ kind: 'planet', name: 'Neptune' }, { fam: null, needFam: null, levels: { 'Straight Flush': 1 }, played: { 'Straight Flush': 0 } }) !== 3) {
        throw new Error('Neptune/SF with no play evidence must sit below the take bar (d2 case)');
    }

    if (scorePackOffer({ kind: 'planet', name: 'Neptune' }, { fam: 'Straight', needFam: 'Straight', levels: { 'Straight Flush': 1 }, played: { 'Straight Flush': 0, 'Two Pair': 3, 'Full House': 3, Straight: 2 } }) !== 3) {
        throw new Error('SF planet with zero plays must not beat TP/3ok evidence (run 1793018705 Neptune pick)');
    }

    if (scorePackOffer({ kind: 'planet', name: 'Neptune' }, { fam: 'Flush', needFam: 'Flush', levels: { 'Straight Flush': 1 }, played: { 'Straight Flush': 4 } }) !== 3) {
        throw new Error('ungrindable SF never taken off-target even with 4 plays');
    }

    /* play-weighted off-target tiers (0565+2315): filler levels must land on the
       high-volume family, not on a 1-2 play neighbor that got there first */
    const tierCtx = { fam: 'Pair', needFam: 'Pair', levels: {}, played: { 'Two Pair': 8, Straight: 4, 'Three of a Kind': 0, 'High Card': 1 } };

    if (!(scorePackOffer({ kind: 'planet', name: 'Uranus' }, tierCtx) === 4.6
        && scorePackOffer({ kind: 'planet', name: 'Saturn' }, tierCtx) === 4.1
        && scorePackOffer({ kind: 'planet', name: 'Pluto' }, tierCtx) === 3
        && scorePackOffer({ kind: 'planet', name: 'Venus' }, tierCtx) === 3)) {
        throw new Error('off-target planet tiers must escalate with plays, ungrindable HC planet floors with Trips (TP8:4.6 Str4:4.1 HC1:3 Trips0:3)');
    }

    /* standard-pack bare enhancers (name-only, no rank): taken 0/9 before the
       case existed; stone unselectable stays skipped */
    if (!(scorePackOffer({ kind: 'Enhanced', name: 'Glass Card' }, {}) === 4.3
        && scorePackOffer({ kind: 'Enhanced', name: 'Mult' }, {}) === 4.2
        && scorePackOffer({ kind: 'Enhanced', name: 'Steel Card' }, {}) === 5
        && scorePackOffer({ kind: 'Enhanced', name: 'Lucky Card' }, {}) === 4
        && scorePackOffer({ kind: 'Enhanced', name: 'Stone Card' }, {}) === 1
        && scorePackOffer({ kind: 'Default', name: 'Default Base' }, {}) === 1)) {
        throw new Error('enhanced card offers must score Steel5>Glass4.3>Mult4.2>Lucky4>Stone1');
    }

    /* Baron: X(extra)=X1.5 per held-not-played King (312/208=1.50 measured); needs hand */
    const baronJ = [{ name: 'Baron', values: { x_mult: 1, extra: 1.5 } }];
    const baronHand = [C('K', 'Hearts'), C('K', 'Spades'), C('Q', 'Diamonds'), C('4', 'Clubs')];
    const baronPlay = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: baronHand });
    const baronNoHand = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: [] });

    if (predict(tabHC, 'High Card', [C('Q', 'Spades')], baronPlay).score !== 34) {
        throw new Error(`baron two held Kings X1.5^2 must apply (15*2.25=33.75->34), got ${predict(tabHC, 'High Card', [C('Q', 'Spades')], baronPlay).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], baronPlay).score !== 23) {
        throw new Error(`played King must not count for baron (1 held, 15*1.5=22.5->23), got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], baronPlay).score}`);
    }

    if (predict(tabHC, 'High Card', [C('Q', 'Spades')], baronNoHand).unc !== true) {
        throw new Error('baron without hand snapshot must mark uncertain, never train a phantom boost');
    }

    /* Played NON-SCORING King kicker still leaves the hand: Pair of 8s played with a K
       kicker must count 1 held King (hand has 2), not 2 — candidate path through
       allSubsetEvals must disagree between the 2-card and 3-card plays */
    const baronTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const baronCards = [
        { ...C('K', 'Hearts'), id: 0, actions: ['select'] },
        { ...C('K', 'Spades'), id: 1, actions: ['select'] },
        { ...C('8', 'Hearts'), id: 2, actions: ['select'] },
        { ...C('8', 'Spades'), id: 3, actions: ['select'] },
        { ...C('5', 'Clubs'), id: 4, actions: ['select'] },
    ];
    const baronCtx = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: baronCards });
    const baronEv = allSubsetEvals(baronCards, baronTab, null, baronCtx);
    const pairNoK = baronEv.find((x) => x.fam === 'Pair' && x.cards.length === 2);
    const pairKick = baronEv.find((x) => x.fam === 'Pair' && x.cards.length === 3 && x.cards.some((c) => c.rank === 'K'));

    if (!pairNoK || pairNoK.pred !== 117) {
        throw new Error(`baron pair without played K must score 26*2*2.25=117, got ${pairNoK?.pred}`);
    }

    if (!pairKick || pairKick.pred !== 78) {
        throw new Error(`baron pair with played K kicker must score 26*2*1.5=78, got ${pairKick?.pred}`);
    }

    /* Crimson Heart (random joker disabled every hand): single-joker engine EV
       must drop to the jokerless score; two-copy engine keeps half its value */
    const chTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const chHand = [
        { ...C('K', 'Hearts'), id: 10, actions: ['select'] },
        { ...C('K', 'Spades'), id: 11, actions: ['select'] },
        { ...C('3', 'Clubs'), id: 12, actions: ['select'] },
    ];
    const chFull = ctxOf({ jokers: [{ name: 'Joker', values: { mult: 30 } }], run: {} });
    const chOne = ctxOf({ jokers: [{ name: 'Joker', values: { mult: 30 } }], run: { blind: { name: 'Crimson Heart' } } });
    const chTwo = ctxOf({
        jokers: [{ name: 'Joker', values: { mult: 30 } }, { name: 'Joker', values: { mult: 30 } }],
        run: { blind: { name: 'Crimson Heart' } },
    });
    /**
     * Best Pair prediction for a context.
     *
     * @param {object} cx - decision context from ctxOf
     * @returns {number} pair prediction
     */
    const chPred = (cx) => allSubsetEvals(chHand, chTab, null, cx).find((x) => x.fam === 'Pair' && x.cards.length === 2).pred;
    const chP1 = chPred(chFull);
    const chP2 = chPred(chOne);
    const chP3 = chPred(chTwo);

    if (!(chP2 < chP1)) {
        throw new Error(`crimson heart must discount single-joker engine: ${chP2} vs full ${chP1}`);
    }

    if (chP3 !== chP1) {
        throw new Error(`crimson heart two-copy EV must equal one-copy full: ${chP3} vs ${chP1}`);
    }

    for (const k of Object.keys(jokerFactor)) {
        delete jokerFactor[k];
        delete jokerSig[k];
    }

    /* The Flint (build text "Base Chips and Mult are halved"): table base halves,
       card chips and joker layers join after — run 4202 Straight measured 516 vs the
       un-halved pred 1009 */
    const flintTab = [{ name: 'Straight', chips: 30, mult: 4, level: 1 }];
    const flintCtx = ctxOf({ jokers: [], run: { discards_left: 1, blind: { name: 'The Flint' } }, hands: [] });
    const flintPlain = ctxOf({ jokers: [], run: { discards_left: 1 }, hands: [] });
    const flintCards = [C('2', 'Spades'), C('3', 'Hearts'), C('4', 'Spades'), C('5', 'Hearts'), C('6', 'Spades')];

    if (predict(flintTab, 'Straight', flintCards, flintCtx).score !== 70) {
        throw new Error(`flint must halve base to (15+20)*2=70, got ${predict(flintTab, 'Straight', flintCards, flintCtx).score}`);
    }

    if (predict(flintTab, 'Straight', flintCards, flintPlain).score !== 200) {
        throw new Error('non-flint straight must stay (30+20)*4=200');
    }

    const flintEv = allSubsetEvals(flintCards.map((c, id) => ({ ...c, id, actions: ['select'] })), flintTab, null, flintCtx);

    const flintRow = flintEv.find((x) => x.fam === 'Straight' && x.cards.length === 5);

    if (!flintRow || flintRow.pred !== 70) {
        throw new Error(`candidate path must inherit flint halving, got ${flintRow?.pred} top=${flintEv.slice(0, 4).map((x) => `${x.fam}@${x.cards.length}:${x.pred}`).join(',')}`);
    }

    /* Joker Stencil: Xmult per empty slot, build publishes current X in x_mult
       (measured: lineup 1/5=>5, 3/3=>3, 5/5=>1) */
    const sten3 = ctxOf({ jokers: [{ name: 'Joker Stencil', values: { x_mult: 3 } }], run: { discards_left: 1 }, hands: [] });
    const sten1 = ctxOf({ jokers: [{ name: 'Joker Stencil', values: { x_mult: 1 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], sten3).score !== 45) {
        throw new Error(`stencil X3 from values must apply, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], sten3).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], sten1).score !== 15) {
        throw new Error('stencil X1 must be a no-op');
    }

    /* Flint rounding PIN (floor): odd base 5/1 -> floor 2/0. Official build floors;
       THIS build's text says only "halved" — live Flint run must confirm before the
       calibrate skip is lifted (skip currently protects both directions) */
    const flintOddTab = [{ name: 'High Card', chips: 5, mult: 1, level: 1 }];

    if (predict(flintOddTab, 'High Card', [C('K', 'Hearts')], flintCtx).score !== 0) {
        throw new Error(`flint floor pin: (2+11)*0=0, got ${predict(flintOddTab, 'High Card', [C('K', 'Hearts')], flintCtx).score}`);
    }

    /* Loyalty Card: X4 exactly on the hand observed with loyalty_remaining=0.
       Run 1793000317 boundary: remaining=1 play gained PLAIN (180 vs pred 195),
       remaining=0 (held across a discard) gained X4 (8064 = 2016x4); after firing
       the counter resets to `every`. The old "never fires" lesson was WRONG. */
    const loyFire = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 0 } }], run: { discards_left: 1 }, hands: [] });
    const loyOne = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 1 } }], run: { discards_left: 1 }, hands: [] });
    const loyCycle = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 3 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyFire).score !== 60) {
        throw new Error(`loyalty X4 must fire on remaining=0, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], loyFire).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyOne).score !== 15) {
        throw new Error('remaining=1 play must score PLAIN (measured 180, boost was one hand later)');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyCycle).score !== 15) {
        throw new Error('loyalty must stay off mid-cycle');
    }

    const loyBlind = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyBlind).unc !== true) {
        throw new Error('loyalty with no countdown field must mark the row uncertain, not guess');
    }
}
