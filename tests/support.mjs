/* Shared assertion fixtures for the selftest topic modules. */
import { ctxOf, predict } from '../lib/play.mjs';

/**
 * Build a minimal selectable card for the assertion suites.
 *
 * @param {string} rank - card rank label
 * @param {string} suit - card suit label
 * @returns {object} card-like object with a select action
 */
export function C(rank, suit) {
    return { rank, suit, actions: ['select'] };
}

export const tabHC = [{ name: 'High Card', chips: 5, mult: 1, level: 1 }];

export const kSc = [C('K', 'Hearts')];

export const obsM0 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 0 }, hands: [] });

export const obsM3 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 3 }, hands: [] });

export const mysticOff = predict(tabHC, 'High Card', kSc, obsM3).score;

export const madCtx = ctxOf({ jokers: [{ name: 'Mad Joker', values: { type: 'High Card', t_mult: 10 } }], run: { discards_left: 1 }, hands: [] });

export const kPair = [C('K', 'Hearts'), C('K', 'Spades')];

export const plainMadCtx = ctxOf({ jokers: [{ name: 'Mad Joker' }], run: { discards_left: 1 }, hands: [] });

export const tHand = [
    { id: 1, rank: 'K', suit: 'Hearts', actions: ['select'] },
    { id: 2, rank: 'Q', suit: 'Spades', actions: ['select'] },
    { id: 3, rank: '2', suit: 'Clubs', actions: ['select'] },
    { id: 4, rank: '7', suit: 'Diamonds', actions: ['select'] },
];
