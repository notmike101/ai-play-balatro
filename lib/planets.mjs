/* planets.mjs — the ONE canonical planet<->family mapping (plus the grind profile).
   Derives every view (fam->key, fam->display, name->fam) from a single table so the
   old "keep in sync with shop.mjs FAM_BY_PLANET" drift can never come back. */

const PLANETS = [
    { fam: 'High Card', key: 'pluto', name: 'Pluto' },
    { fam: 'Pair', key: 'mercury', name: 'Mercury' },
    { fam: 'Two Pair', key: 'uranus', name: 'Uranus' },
    { fam: 'Three of a Kind', key: 'venus', name: 'Venus' },
    { fam: 'Straight', key: 'saturn', name: 'Saturn' },
    { fam: 'Flush', key: 'jupiter', name: 'Jupiter' },
    { fam: 'Full House', key: 'earth', name: 'Earth' },
    { fam: 'Four of a Kind', key: 'mars', name: 'Mars' },
    { fam: 'Straight Flush', key: 'neptune', name: 'Neptune' },
];

/** family -> planet card key fragment (e.g. Pair -> 'mercury') */
const PLANET_KEY = Object.fromEntries(PLANETS.map((p) => [p.fam, p.key]));

/** family -> planet display name (pack offers are matched by name) */
const PLANET_NAME = Object.fromEntries(PLANETS.map((p) => [p.fam, p.name]));

/** planet display name -> family (shop shelf/pack item lookup) */
const FAM_BY_PLANET = Object.fromEntries(PLANETS.map((p) => [p.name, p.fam]));

/** the set of planet display names */
const PLANET_NAMES = new Set(PLANETS.map((p) => p.name));

/* families the RED pair-heavy profile can realistically grind (levels here compound;
   SF/4ok/FH never close — dead planet picks per window forensics); shared with shop targeting.
   High Card REMOVED (era census: HC focal x7, HC-L3 EV ~700/hand died a2-a4 every time -
   leveling HC burned Plutos while offered Urans starve-blocked, e.g. 1793143662 a4) */
const PLANET_GRIND = new Set(['Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush']);

export { PLANETS, PLANET_KEY, PLANET_NAME, FAM_BY_PLANET, PLANET_NAMES, PLANET_GRIND };
