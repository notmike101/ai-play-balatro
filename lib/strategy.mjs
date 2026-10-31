/* strategy.mjs — run-level SCORING DECISIONS: which poker family to specialize in
   (chooseStrategy/famBiasMap) and which consumables to use right now (planConsumables).
   Pure decision helpers: no IO, no game calls, no randomness. Joker knowledge lives in
   jokers.mjs, planet maps in planets.mjs, pack valuation in pack.mjs, targeted tarot
   card selection in tarot.mjs. */

import { PLANET_GRIND } from './planets.mjs';
import { classifyJoker, jokerFamBonus, planetCounts } from './jokers.mjs';

// v1 consumable use-allowlist; unknown keys are never planned. pri orders the plan (money first)
const TAROT_RULES = [
    { id: 'emperor', pri: 0, gate: 'always', re: /\bemperor\b/i, why: 'Emperor: immediate money' },
    { id: 'judgement', pri: 0, gate: 'poor', re: /\bjude?gement\b/i, why: 'Judgement: create a Joker when broke' },
    { id: 'immolate', pri: 0, gate: 'burn', re: /\bimmolate\b/i, why: 'Immolate: burn five hand cards for $20' },
    { id: 'priestess', pri: 1, gate: 'always', re: /priestess/i, why: 'High Priestess: creates two planet cards' },
    { id: 'death', pri: 2, gate: 'hand', re: /\bdeath\b/i, why: 'Death: execute two cards to pump the chosen family' },
    { id: 'soul', pri: 3, gate: 'slot', re: /\bsoul\b/i, why: 'Soul: search for a Legendary Joker' },
    { id: 'wheel', pri: 1, gate: 'always', re: /wheel of fortune/i, why: 'Wheel: 1-in-4 edition on a random Joker' },
    { id: 'hermit', pri: 0, gate: 'dupe', re: /\bhermit\b/i, why: 'Hermit: double held money (cap $20)' },
    /* blackhole: +1 EVERY hand level (build truth, user-confirmed 10-29) - no timing
       downside, permanent upside on focal + all side grinds */
    { id: 'blackhole', pri: 0, gate: 'always', re: /black ?hole/i, why: 'Black Hole: +1 level every hand (focal included)' },
];

/**
 * Accumulate the family-specialization score for one observed poker hand.
 *
 * @param {string} fam - family name as reported in obs.hands
 * @param {object} hand - hand record with level/played counters
 * @param {object[]} jokers - observed jokers
 * @param {Record<string, number>} planets - family -> owned planet count
 * @returns {{level: number, played: number, planets: number, jokers: number, score: number}} score parts
 */
function scoreFamily(fam, hand, jokers, planets) {
    const level = typeof hand.level === 'number' ? hand.level : 1;
    const played = typeof hand.played === 'number' ? hand.played : 0;
    const planetN = planets[fam] ?? 0;
    let jokerN = 0;

    for (const j of jokers) {
        jokerN += jokerFamBonus(j, fam);
    }

    return {
        level,
        played,
        planets: planetN,
        jokers: jokerN,
        /* OPPORTUNITY COST (user directive; 3x LOW_FOCAL deaths 1793332572/068/414:
           TP focal stuck L1-L2 while Flush/3K/Pair rode L3 - the old score counted
           plays and levels in arbitrary units, never CHIPS. Focal routes every future
           level action, so rank families by expected chips per blind:
           live table score (chips+card chips) x mult x frequency weight (game's own
           played counter). Log-scale so supply signals (planets/jokers) still swing
           close races instead of drowning in raw magnitudes.
           OBSERVED-vs-MODEL: card-chip adder 24 ~ 3 scoring cards x ~8 avg chip. */
        score: (typeof hand.chips === 'number' && typeof hand.mult === 'number'
            ? Math.log1p((hand.chips + 24) * hand.mult * (1 + 0.25 * Math.min(played, 12))) * 0.35
            : 0.5 * level)
        + 0.5 * level + 0.25 * Math.min(played, 10) + 2 * planetN + jokerN
        - (PLANET_GRIND.has(fam) ? 0 : 1.5),
    };
}

/**
 * Rank candidate families by score, then level, then fewer plays, then name.
 *
 * @param {Record<string, number>} scores - family -> specialization score
 * @param {Record<string, object>} meta - family -> scoreFamily breakdown
 * @returns {(string | null)} family that should win, or null when scores are undifferentiated
 */
function pickBestFam(scores, meta) {
    const fams = Object.keys(scores);

    fams.sort((a, b) => {
        const ds = scores[b] - scores[a];

        if (ds !== 0) {
            return ds;
        }

        const dl = meta[b].level - meta[a].level;

        if (dl !== 0) {
            return dl;
        }

        const dp = meta[a].played - meta[b].played;

        if (dp !== 0) {
            return dp;
        }

        return a.localeCompare(b);
    });

    if (fams.length > 1 && scores[fams[0]] === scores[fams[1]]) {
        return null;
    }

    return fams[0];
}

/**
 * Pick the hand family this run should specialize in (levels, plays, planets, joker hints;
 * each xmult joker adds a flat +0.4 to the current best family).
 *
 * @param {object} [obs] - observation with hands/jokers/consumables
 * @returns {{fam: (string | null), why: string}} chosen family (null = raw EV) plus justification
 */
function chooseStrategy(obs) {
    const hands = Array.isArray(obs?.hands) ? obs.hands : [];
    const jokers = Array.isArray(obs?.jokers) ? obs.jokers : [];
    const planets = planetCounts(Array.isArray(obs?.consumables) ? obs.consumables : []);
    const scores = {};
    const meta = {};

    for (const h of hands) {
        if (typeof h?.name !== 'string') {
            continue;
        }

        /* FOCAL MUST BE GRINDABLE (8th HC-focal 1793168504: 18 HC plays to a5 death while the
           real grinders Flush/Straight sat L2 — HC base+cap plays outscore leveled
           grinders but ~700/hand never clears a4+; then era census of FH-focal: 612/617/619/620
           all focal=Full House with lvlAct 0 and EMPTY lvlMaps — a focal outside PLANET_GRIND
           matches no planet the shop pipeline can ever buy or take (focal30 never fires,
           starved-boost dead), so the whole run levels nothing and dies a3-a4 at L1.
           Skipping every non-grindable family (HC/FH/4ok/SF) keeps the focal label, joker
           hints and pack focal bonus on the family levels can actually raise; EV play
           selection still plays the FH when it shows up. */
        if (!PLANET_GRIND.has(h.name)) {
            continue;
        }

        const r = scoreFamily(h.name, h, jokers, planets);

        scores[h.name] = r.score;
        meta[h.name] = r;
    }

    if (Object.keys(scores).length === 0) {
        return { fam: 'High Card', why: 'no hand data observed' };
    }

    const xmultN = jokers.filter((j) => j && classifyJoker(j).cat === 'xmult').length;

    if (xmultN > 0) {
        const bf = pickBestFam(scores, meta);

        if (bf) {
            scores[bf] += 0.4 * xmultN;
        }
    }

    const fam = pickBestFam(scores, meta);

    if (fam === null) {
        return { fam: null, why: 'no differentiating signal; play raw EV' };
    }

    const chosen = meta[fam];
    const bits = [`level ${chosen.level}`];

    if (chosen.planets > 0) {
        bits.push(`${chosen.planets} planet card(s)`);
    }

    if (chosen.jokers > 0) {
        bits.push(`${chosen.jokers.toFixed(1)} joker points`);
    }

    if (xmultN > 0) {
        bits.push(`${xmultN} xmult joker(s) flat bonus`);
    }

    return { fam, why: `${fam} scores ${scores[fam].toFixed(2)} (${bits.join(', ')})` };
}

/**
 * Build the per-family bias multipliers the driver applies when evaluating candidate plays.
 * Never below 1: chosen family 1.25, level>=3 families 1.1, everyone else 1.
 *
 * @param {{fam?: string}|null} [strat] - chooseStrategy result
 * @param {object} [obs] - observation whose hands define the family universe
 * @returns {Record<string, number>} family -> bias multiplier
 */
function famBiasMap(strat, obs) {
    const out = {};

    for (const h of Array.isArray(obs?.hands) ? obs.hands : []) {
        if (typeof h?.name !== 'string') {
            continue;
        }

        if (h.name === strat?.fam) {
            out[h.name] = 1.25;
        } else if (typeof h.level === 'number' && h.level >= 3) {
            out[h.name] = 1.1;
        } else {
            out[h.name] = 1;
        }
    }

    if (typeof strat?.fam === 'string' && !Object.hasOwn(out, strat.fam)) {
        out[strat.fam] = 1.25;
    }

    return out;
}

/**
 * Whether a consumable can actually be used right now (needs 'use' in its actions).
 *
 * @param {object} [c] - observed consumable
 * @returns {boolean} true when the use action is offered
 */
function usable(c) {
    return Array.isArray(c?.actions) && c.actions.includes('use');
}

/**
 * Match a consumable against the v1 allowlist (key or name, case-insensitive).
 *
 * @param {object} c - observed consumable
 * @returns {object|null} the first matching TAROT_RULES entry, null for unknown consumables
 */
function pickRule(c) {
    const hay = `${c?.key ?? ''} ${c?.name ?? ''}`;

    for (const rule of TAROT_RULES) {
        if (rule.re.test(hay)) {
            return rule;
        }
    }

    return null;
}

/**
 * Gate check for a planned consumable use (money, hand-targeting, burn safety, free slot).
 *
 * @param {string} gate - rule gate id
 * @param {object} ctx - plan context (deckHealthy etc.)
 * @param {number} money - current money from ctx
 * @param {number} ante - current ante from ctx
 * @param {boolean} handReady - targeted tarots can pick hand cards right now
 * @param {boolean} slotFree - consumable area has room
 * @returns {boolean} whether the use is allowed this call
 */
function gateAllows(gate, ctx, money, ante, handReady, slotFree) {
    switch (gate) {
        case 'poor':
            return money < 25;
        case 'hand':
            return handReady;
        case 'burn':
            return money >= 0 && ctx.deckHealthy !== false && ante <= 6;
        case 'rich':
            return money >= 2;
        case 'dupe':
            /* skip-era reality (digests 10-31: $1 at every blind-select, Hermit held
               until death by 559-chip gap): doubling is +money from $1 up, so only $0
               is a no-op */
            return money >= 1;
        case 'slot':
            return slotFree;
        default:
            return true;
    }
}

/**
 * Plan up to two consumable uses for this moment (planets excluded — the driver plays
 * those per-hand). Deterministic order: money-making first; unknown keys never planned.
 *
 * @param {object} [obs] - observation with consumables (and optional area slot info)
 * @param {{fam?: string}|null} [strat] - chooseStrategy result
 * @param {object} [ctx] - {ante, money, phase, handReady, deckHealthy, slotFreeNumber}
 * @returns {Array<{target: number, why: string}>} consumable ids to use, in order
 */
function planConsumables(obs, strat, ctx = {}) {
    const cons = Array.isArray(obs?.consumables) ? obs.consumables : [];
    const money = typeof ctx.money === 'number' ? ctx.money : 0;
    const ante = typeof ctx.ante === 'number' ? ctx.ante : 0;
    const handReady = ctx.handReady === true || ctx.phase === 'hand';
    let slots = 2;

    if (typeof ctx.slotFreeNumber === 'number') {
        slots = ctx.slotFreeNumber;
    } else if (typeof obs?.area?.consumable_slots === 'number') {
        slots = obs.area.consumable_slots;
    }

    const slotFree = cons.length < slots;
    const planned = [];

    for (const c of cons) {
        const rule = c && c.id !== undefined ? pickRule(c) : null;

        if (rule === null || !usable(c)) {
            continue;
        }

        if (!gateAllows(rule.gate, ctx, money, ante, handReady, slotFree)) {
            continue;
        }

        const why = rule.id === 'death' ? `Death: execute two cards to pump ${strat?.fam ?? 'the run'}` : rule.why;

        planned.push({ pri: rule.pri, target: c.id, why });
    }

    planned.sort((a, b) => a.pri - b.pri);

    return planned.slice(0, 2).map(({ target, why }) => ({ target, why }));
}

/**
 * Whether the current joker slot arrangement differs from a proposed id order.
 *
 * @param {object[]} [currentJokers] - observed jokers with slot numbers
 * @param {number[]} [orderIds] - jokerOrder result
 * @returns {boolean} true when a drag-reorder is needed
 */
function reorderNeeds(currentJokers, orderIds) {
    const proposed = Array.isArray(orderIds) ? orderIds : [];
    const list = Array.isArray(currentJokers) ? [...currentJokers] : [];

    list.sort((a, b) => (typeof a?.slot === 'number' ? a.slot : 0) - (typeof b?.slot === 'number' ? b.slot : 0));

    const current = list.map((j) => j?.id);

    if (current.length !== proposed.length) {
        return true;
    }

    for (const [i, id] of current.entries()) {
        if (id !== proposed[i]) {
            return true;
        }
    }

    return false;
}

export {
    chooseStrategy, famBiasMap, planConsumables, reorderNeeds, gateAllows,
};
