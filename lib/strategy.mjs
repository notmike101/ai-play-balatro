/* strategy.mjs — pure decision helpers for the driver: joker classification/ordering,
   family specialization scoring, consumable use plans. No IO, no game calls, no randomness. */

// effect-text fragments used to bucket jokers into scoring classes
const MULT_RE = /mult/i;
const XMULT_RE = /x ?mult|xmult|multiplied|\btimes\b|x\s*#?\d#?\s*mult/i;
const CHIPS_RE = /\+\s*(?:#\d#|\d+)\s*chips/i;
const ADD_RE = /\+\s*(?:#\d#|\d+)\s*mult/i;
const ECON_RE = /\$|money|sell|interest/i;

// key-based fallback categories for famous jokers whose effect text is empty or unparseable
const KEY_CAT = {
    j_bull: 'econ',
    j_blueprint: 'util',
    j_brainstorm: 'util',
};

// key-based family hints for jokers that enable a family without naming it in a +Chips/+Mult line
const KEY_FAM = {};

// family word detectors, most specific first so 'Two Pair' never reads as 'Pair'
const FAM_RES = {
    'Straight Flush': /straight flush|royal flush|five card straight/i,
    'Five of a Kind': /five of a kind/i,
    'Four of a Kind': /four of a kind/i,
    'Full House': /full house/i,
    'Three of a Kind': /three of a kind/i,
    'Two Pair': /two pair/i,
    'High Card': /high card/i,
    Straight: /straight/i,
    Flush: /flush/i,
    'Five Card': /five card/i,
    Pair: /\bpair\b/i,
};

// ordering of FAM_RES keys matters: findFamily returns the first pattern that matches
const FAM_ORDER = Object.keys(FAM_RES);

/* canonical Balatro planet->family mapping (Pluto=High Card .. Neptune=Straight Flush);
   keep in sync with shop.mjs FAM_BY_PLANET */
const PLANET_KEY = {
    'High Card': 'pluto',
    Pair: 'mercury',
    'Two Pair': 'uranus',
    'Three of a Kind': 'venus',
    Straight: 'mars',
    Flush: 'jupiter',
    'Full House': 'saturn',
    'Four of a Kind': 'earth',
    'Straight Flush': 'neptune',
};

/* display names of the same planets, for pack-offer scoring by card name;
   keep in sync with shop.mjs FAM_BY_PLANET */
const PLANET_NAME = {
    'High Card': 'Pluto',
    Pair: 'Mercury',
    'Two Pair': 'Uranus',
    'Three of a Kind': 'Venus',
    Straight: 'Mars',
    Flush: 'Jupiter',
    'Full House': 'Saturn',
    'Four of a Kind': 'Earth',
    'Straight Flush': 'Neptune',
};

// how far apart the joker classes must sit in the ideal scoring order
const CAT_RANK = {
    chips: 0,
    add: 1,
    xmult: 2,
    econ: 3,
    util: 4,
    unk: 5,
};

// money/utility tarots and safe spectrals usable without card targets (pack valuation table)
const TAROT_AUTO = [
    [/high priestess/i, 'two planets'],
    [/emperor/i, 'money cards'],
    [/judgement/i, 'money for joker'],
    [/tower(?! the)/i, 'stone card'],
    [/hierophant|lover/i, 'boost card'],
];
const SPECTRAL_AUTO = [
    [/immolate/i, 'burn 5 +$20'],
    [/soul/i, 'rare jokers'],
    [/tarmigan|hex/i, 'utility'],
];

// v1 consumable use-allowlist; unknown keys are never planned. pri orders the plan (money first)
const TAROT_RULES = [
    { id: 'emperor', pri: 0, gate: 'always', re: /\bemperor\b/i, why: 'Emperor: immediate money' },
    { id: 'judgement', pri: 0, gate: 'poor', re: /\bjude?gement\b/i, why: 'Judgement: create a Joker when broke' },
    { id: 'immolate', pri: 0, gate: 'burn', re: /\bimmolate\b/i, why: 'Immolate: burn five hand cards for $20' },
    { id: 'priestess', pri: 1, gate: 'always', re: /priestess/i, why: 'High Priestess: creates two planet cards' },
    { id: 'death', pri: 2, gate: 'hand', re: /\bdeath\b/i, why: 'Death: execute two cards to pump the chosen family' },
    { id: 'soul', pri: 3, gate: 'slot', re: /\bsoul\b/i, why: 'Soul: search for a Legendary Joker' },
];

/**
 * Flatten a joker's effect-template lines into one searchable lowercase string.
 *
 * @param {object} [j] - observed joker (may be missing fields entirely)
 * @returns {string} the joined effect text, empty when absent
 */
function jokerText(j) {
    return Array.isArray(j?.effect) ? j.effect.join(' ').toLowerCase() : '';
}

/**
 * Detect which scoring family a joker's effect text boosts, if any.
 *
 * @param {string} text - lowercased joined effect text
 * @returns {string|null} family label (e.g. 'Flush') or null for face-card/broad jokers
 */
function findFamily(text) {
    for (const fam of FAM_ORDER) {
        if (FAM_RES[fam].test(text)) {
            return fam;
        }
    }

    return null;
}

/**
 * Bucket a joker into the class that drives scoring order (chips/add/xmult/econ/util/unk).
 *
 * @param {object} [j] - observed joker with effect lines and optional key
 * @returns {{cat: string, famHint: string|null}} classification plus the family it boosts
 */
function classifyJoker(j) {
    const text = jokerText(j);
    const fam = findFamily(text);
    let cat = 'unk';

    if (MULT_RE.test(text) && XMULT_RE.test(text)) {
        cat = 'xmult';
    } else if (CHIPS_RE.test(text)) {
        cat = 'chips';
    } else if (ADD_RE.test(text)) {
        cat = 'add';
    } else if (ECON_RE.test(text)) {
        cat = 'econ';
    } else if (fam !== null) {
        cat = 'util';
    } else if (KEY_CAT[j?.key] !== undefined) {
        cat = KEY_CAT[j?.key];
    }

    return { cat, famHint: fam ?? KEY_FAM[j?.key] ?? null };
}

/**
 * Produce the ideal joker slot order: flat-chip jokers first, then additive Mult, then every
 * X-mult (its product multiplies everything before it), then economy/utility/unknown tail.
 * Stable within a class by current slot; debuffed jokers keep relative order.
 *
 * @param {object[]} [jokers] - observed joker array (may be missing or malformed)
 * @returns {number[]} joker ids in the order they should occupy
 */
function jokerOrder(jokers) {
    const tagged = [];

    for (const j of Array.isArray(jokers) ? jokers : []) {
        if (!j || j.id === undefined) {
            continue;
        }

        tagged.push({
            id: j.id,
            rank: CAT_RANK[classifyJoker(j).cat] ?? 5,
            slot: typeof j.slot === 'number' ? j.slot : 0,
        });
    }

    tagged.sort((a, b) => a.rank - b.rank || a.slot - b.slot);

    return tagged.map((t) => t.id);
}

/**
 * Count planet cards in the consumable area grouped by the family they level up.
 *
 * @param {object[]} cons - observed consumables
 * @returns {Record<string, number>} family -> planet card count
 */
function planetCounts(cons) {
    const out = {};

    for (const c of cons) {
        const hay = `${c?.key ?? ''} ${c?.name ?? ''} ${c?.kind ?? ''}`.toLowerCase();

        if (!hay.includes('planet')) {
            continue;
        }

        for (const [fam, frag] of Object.entries(PLANET_KEY)) {
            if (hay.includes(frag)) {
                out[fam] = (out[fam] ?? 0) + 1;
                break;
            }
        }
    }

    return out;
}

/**
 * Specialization score one joker contributes to one family (1.5 for an exact family hint,
 * 1 for a chips/add joker whose text names the family; the xmult flat bonus is applied globally).
 *
 * @param {object} [j] - observed joker
 * @param {string} fam - candidate scoring family
 * @returns {number} bonus points toward that family
 */
function jokerFamBonus(j, fam) {
    if (!j) {
        return 0;
    }

    const cl = classifyJoker(j);

    if (cl.famHint === fam) {
        return 1.5;
    }

    if ((cl.cat === 'chips' || cl.cat === 'add') && FAM_RES[fam]?.test(jokerText(j))) {
        return 1;
    }

    return 0;
}

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
        score: 0.5 * level + 0.25 * Math.min(played, 10) + 2 * planetN + jokerN,
    };
}

/**
 * Rank candidate families by score, then level, then fewer plays, then name.
 *
 * @param {Record<string, number>} scores - family -> specialization score
 * @param {Record<string, object>} meta - family -> scoreFamily breakdown
 * @returns {string} family that should win the specialization choice
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

    return fams[0];
}

/**
 * Pick the hand family this run should specialize in (levels, plays, planets, joker hints;
 * each xmult joker adds a flat +0.4 to the current best family).
 *
 * @param {object} [obs] - observation with hands/jokers/consumables
 * @returns {{fam: string, why: string}} chosen family plus a human-readable justification
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

        const r = scoreFamily(h.name, h, jokers, planets);

        scores[h.name] = r.score;
        meta[h.name] = r;
    }

    if (Object.keys(scores).length === 0) {
        return { fam: 'High Card', why: 'no hand data observed' };
    }

    const xmultN = jokers.filter((j) => j && classifyJoker(j).cat === 'xmult').length;

    if (xmultN > 0) {
        scores[pickBestFam(scores, meta)] += 0.4 * xmultN;
    }

    const fam = pickBestFam(scores, meta);
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

/**
 * Dominant suit in hand for flush-building picks (obs.hand only; null when unknown).
 *
 * @param {object} [obs] - current observation
 * @returns {(string|null)} suit name when at least 3 share it, else null
 */
function dominantSuit(obs) {
    const cnt = {};

    for (const c of Array.isArray(obs?.hand) ? obs.hand : []) {
        if (c?.suit) {
            cnt[c.suit] = (cnt[c.suit] ?? 0) + 1;
        }
    }

    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];

    return top && top[1] >= 3 ? top[0] : null;
}

/**
 * Score one booster-pack offer for take/skip against the run strategy.
 *
 * @param {object} [o] - pack offer item (kind/planet/tarot/card shapes)
 * @param {object} [ctx] - {fam, needFam, suit, levels} run state for valuation
 * @returns {number} score; take when >= 4
 */
function scorePackOffer(o, ctx = {}) {
    switch (String(o?.kind ?? '').toLowerCase()) {
        case 'joker':
            return classifyJoker(o).famHint === ctx.fam ? 14 : 5;
        case 'planet': {
            const f = Object.entries(PLANET_NAME).find(([, n]) => n === o?.name)?.[0];

            if (f === ctx.fam || f === ctx.needFam) {
                return 30;
            }

            return (ctx.levels?.[f] ?? 1) < 5 ? 8 : 3;
        }
        case 'tarot':
            return TAROT_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 8 : 4;
        case 'spectral':
            return SPECTRAL_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 6 : 3;
        default:
            break;
    }

    if (o?.rank !== undefined) {
        let s = 1;

        if (ctx.fam === 'Flush' && o.suit === ctx.suit) {
            s += 6;
        } else if (o.suit === ctx.suit) {
            s += 1.5;
        }

        if (o.rank === 'Ace') {
            s += 3;
        } else if (['King', 'Queen', 'Jack'].includes(o.rank)) {
            s += 2;
        }

        if ((o.enhancements ?? []).length > 0) {
            s += 2;
        }

        if (/seal/i.test(String(o.seal ?? ''))) {
            s += 2;
        }

        return s;
    }

    return 1;
}

const RANKV = { Ace: 14, A: 14, King: 13, K: 13, Queen: 12, Q: 12, Jack: 11, J: 11 };

/**
 * Numeric rank value for a card (0 for unknown/face-down).
 *
 * @param {object} c - card observation
 * @returns {number} 2..14 or 0
 */
function rvOf(c) {
    const n = Number(c && c.rank);

    if (!Number.isNaN(n)) {
        return n;
    }

    return RANKV[c && c.rank] ?? 0;
}

/**
 * One targeted tarot play for the current hand: caller selects cards (left-to-right) then uses.
 * v1 covers Magician(2x Lucky), Empress(2x Mult +4), Tower(Stone +50), Death(left becomes copy
 * of right), Hierophant(2x Bonus +30 chips); suit-conversions excluded (submenu choice unknown).
 *
 * @param {object} obs - hand-phase observation
 * @returns {object[]} at most one {target, cards, why} plan
 */
function planTargeted(obs) {
    const cards = ((obs && obs.hand) || []).filter((c) => !c.debuffed && (c.actions || []).includes('select') && c.rank !== null && c.rank !== undefined && c.rank !== '');

    if (cards.length < 2) {
        return [];
    }

    const cons = (obs.consumables || []).filter((c) => c.kind === 'tarot' && (c.actions || []).includes('use'));
    const byRv = [...cards].sort((a, b) => rvOf(b) - rvOf(a));
    let plan = null;

    for (const c of cons) {
        const nm = `${c.name || ''} ${c.key || ''}`;

        if (/magician/i.test(nm)) {
            plan = { target: c.id, cards: [byRv[0], byRv[1]], why: 'lucky top 2' };
        } else if (/empress/i.test(nm)) {
            plan = { target: c.id, cards: [byRv[0], byRv[1]], why: 'empress +4 mult x2' };
        } else if (/tower/i.test(nm)) {
            plan = { target: c.id, cards: [byRv[byRv.length - 1]], why: 'stone junk +50 chips' };
        } else if (/death/i.test(nm)) {
            // left selected becomes a copy of the right: sacrifice 2nd-best, keep two of the best
            plan = { target: c.id, cards: [byRv.find((x) => x.rank !== byRv[0].rank) ?? byRv[1], byRv[0]], why: 'death copy->best' };
        } else if (/hierophant/i.test(nm)) {
            plan = { target: c.id, cards: [byRv[0], byRv[1]], why: 'hierophant +30 chips x2' };
        }

        if (plan) {
            break;
        }
    }

    return plan ? [plan] : [];
}

export {
    classifyJoker, jokerOrder, chooseStrategy, famBiasMap, planConsumables, planTargeted, reorderNeeds,
    dominantSuit, scorePackOffer, PLANET_KEY, PLANET_NAME, TAROT_AUTO, SPECTRAL_AUTO,
};
