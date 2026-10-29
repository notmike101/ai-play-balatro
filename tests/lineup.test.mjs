/* Selftest chunk: Joker lineup signatures and residual-factor gating (split from the monolith 10-29; run via selftest.mjs). */
import { C, tabHC, kSc, mysticOff, madCtx, kPair, plainMadCtx } from './support.mjs';

/**
 * Joker lineup signatures and residual-factor gating assertions; throws on first failure.
 */
export async function runJokerLineup() {
    const { predict, ctxOf } = await import('../lib/play.mjs');
    const { jokerFactor, jokerSig } = await import('../lib/knowledge.mjs');

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
}
