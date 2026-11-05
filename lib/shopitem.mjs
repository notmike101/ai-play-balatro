// shopitem.mjs — pure shop/pack item predicates (extracted verbatim from shop.mjs, 11-04 health wave).
import { PLANET_NAMES, planetFam } from './planets.mjs';
import { jokerTier, JUNK_JOKER } from './jokers.mjs';

/**
 * Return the joker tier; junk names count as tier 0 so swaps sell them first.
 *
 * @param {(string | undefined)} n - joker name
 * @returns {number} tier (0 for junk)
 */
export function tierOf(n) {
    return JUNK_JOKER.test(n || '') ? 0 : jokerTier(n);
}

/**
 * Return true when an item offers a given action.
 *
 * @param {object} it - shop or pack item
 * @param {string} a - action name
 * @returns {boolean} true when the item lists the action
 */
export function has(it, a) {
    return (it.actions || []).includes(a);
}

/**
 * Return an item's kind lowercased.
 *
 * @param {object} it - shop or pack item
 * @returns {string} lowercased kind
 */
export function kind(it) {
    return String(it.kind || '').toLowerCase();
}

/**
 * Return truthy when an item is a buyable planet card.
 *
 * @param {object} i - shop item
 * @returns {(boolean | string | null)} planetFam result when buyable
 */
export function isPl(i) {
    return (has(i, 'buy_and_use') || has(i, 'buy')) && (kind(i) === 'planet' || PLANET_NAMES.has(i.name || '')) && planetFam(i);
}

/**
 * Return true when a booster pack is worth opening given money and ante.
 *
 * @param {object} item - booster offer
 * @param {object} obs - current observation
 * @returns {boolean} true when worth opening
 */
export function wantPack(item, obs) {
    const n = (item.name || '') + (item.effect || []).join(' ');
    const m = obs.run?.money ?? 0;

    if (/celestial/i.test(n)) {
        return m >= 4;
    }

    if (/buffoon/i.test(n)) {
        return m >= 5;
    }

    if (/standard/i.test(n)) {
        return (obs.run?.ante ?? 1) >= 3 && m >= 7;
    }

    if (/arcana/i.test(n)) {
        return m >= 9 && (obs.run?.ante ?? 1) >= 3;
    }

    if (/spectral/i.test(n)) {
        return m >= 10;
    }

    return false;
}
