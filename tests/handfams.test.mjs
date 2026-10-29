/* Selftest chunk: Hand-family recognition and base prediction (split from the monolith 10-29; run via selftest.mjs). */
import { C, tabHC, kSc, obsM0, mysticOff, madCtx } from './support.mjs';

/**
 * Hand-family recognition and base prediction assertions; throws on first failure.
 */
export async function runHandFamilies() {
    const { evalHand } = await import('../lib/eval.mjs');
    const { predict, calibrate, knownLayer, ctxOf, allSubsetEvals } = await import('../lib/play.mjs');
    const { jokerFactor } = await import('../lib/knowledge.mjs');

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

    const mysticOn = predict(tabHC, 'High Card', kSc, obsM0).score;

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

    if (predict(tabHC, 'High Card', kSc, madCtx).score !== mysticOff * 11) {
        throw new Error(`mad joker t_mult must be exact ${predict(tabHC, 'High Card', kSc, madCtx).score}`);
    }
}
