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

/* NAME-based family hints: this build reports NULL effect text for these jokers
   (out/log.jsonl Splash rows: `["Splash",null,null,{...}]`), so fam is unparseable and
   the family scorer goes blind - run 207 held Splash, let Jupiter pass at Flush L1,
   died a5 CHIP_GAP. Splash = any-suit flushes; Four Fingers = flush with 4 cards
   (dominant use over 4ok); Shortcut = gapped straights. */
const NAME_FAM = { splash: 'Flush', 'four fingers': 'Flush', shortcut: 'Straight' };

/* NAME-based class buckets: same NULL-effect-text build bug as NAME_FAM - without
   this every X-mult joker classifies 'unk', so the catBonus/mw xmult path never fires
   (a6 CHIP_GAP census: boards locked Cloud9/Castle/Stone by ante4, Ramen/Baron/
   Baseball Card/Photograph/Campfire confirmed in pool but never bought). Pool-verified
   names first; only true x_mult classics below (catBonus xmult=2 + mw). */
const NAME_CAT = {
    blueprint: 'xmult', brainstorm: 'xmult', 'the duo': 'xmult', 'the trio': 'xmult', 'the family': 'xmult', 'the house': 'xmult', 'the mark': 'xmult', obelisk: 'xmult', ramen: 'xmult', baron: 'xmult', 'baseball card': 'xmult', photograph: 'xmult', campfire: 'xmult', supernova: 'xmult', constellation: 'xmult', 'the half': 'xmult', 'ice cream': 'xmult', popsicle: 'xmult', cavendish: 'xmult', 'gros michel': 'xmult', canio: 'xmult', triboulet: 'xmult', yorick: 'xmult', mime: 'xmult', vampire: 'xmult', 'hit the road': 'xmult', smeared: 'xmult',
};

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
    Straight: 'saturn',
    Flush: 'jupiter',
    'Full House': 'earth',
    'Four of a Kind': 'mars',
    'Straight Flush': 'neptune',
};

/* display names of the same planets, for pack-offer scoring by card name;
   keep in sync with shop.mjs FAM_BY_PLANET */
const PLANET_NAME = {
    'High Card': 'Pluto',
    Pair: 'Mercury',
    'Two Pair': 'Uranus',
    'Three of a Kind': 'Venus',
    Straight: 'Saturn',
    Flush: 'Jupiter',
    'Full House': 'Earth',
    'Four of a Kind': 'Mars',
    'Straight Flush': 'Neptune',
};

/* families the RED pair-heavy profile can realistically grind (levels here compound;
   SF/4ok/FH never close — dead planet picks per window forensics); shared with shop targeting */
const PLANET_GRIND = new Set(['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush']);

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
    [/wheel of fortune/i, 'joker edition roll'],
    [/hermit/i, 'money x2'],
];
const SPECTRAL_AUTO = [
    [/immolate/i, 'burn 5 +$20'],
    [/soul/i, 'rare jokers'],
    /* hex OUT: the build Hex wrecked our OWN lineup — Lusty+Joker+Baron dropped to
       lone Lusty at blind select right after the auto-use of the taken Hex (run
       1793031744, died a3 Arm 2044 short with a one-joker engine) */
    [/tarmigan/i, 'utility'],
];

// v1 consumable use-allowlist; unknown keys are never planned. pri orders the plan (money first)
const TAROT_RULES = [
    { id: 'emperor', pri: 0, gate: 'always', re: /\bemperor\b/i, why: 'Emperor: immediate money' },
    { id: 'judgement', pri: 0, gate: 'poor', re: /\bjude?gement\b/i, why: 'Judgement: create a Joker when broke' },
    { id: 'immolate', pri: 0, gate: 'burn', re: /\bimmolate\b/i, why: 'Immolate: burn five hand cards for $20' },
    { id: 'priestess', pri: 1, gate: 'always', re: /priestess/i, why: 'High Priestess: creates two planet cards' },
    { id: 'death', pri: 2, gate: 'hand', re: /\bdeath\b/i, why: 'Death: execute two cards to pump the chosen family' },
    { id: 'soul', pri: 3, gate: 'slot', re: /\bsoul\b/i, why: 'Soul: search for a Legendary Joker' },
    { id: 'wheel', pri: 1, gate: 'always', re: /wheel of fortune/i, why: 'Wheel: 1-in-4 edition on a random Joker' },
    { id: 'hermit', pri: 0, gate: 'rich', re: /\bhermit\b/i, why: 'Hermit: double held money (cap $20)' },
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
    } else if (NAME_CAT[String(j?.name ?? '').toLowerCase()] !== undefined) {
        cat = NAME_CAT[String(j?.name ?? '').toLowerCase()];
    }

    return { cat, famHint: fam ?? KEY_FAM[j?.key] ?? NAME_FAM[String(j?.name ?? '').toLowerCase()] ?? null };
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
 * @param {object} [ctx] - {fam, needFam, suit, levels, played} run state for valuation
 * @returns {number} score; callers take strictly above 3 (bar is s > bs with bs = 3)
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

            /* non-target planets need play evidence on a GRINDABLE fam; unplayed
               high-BASE fams (Pluto->SF picked over 3-play TP, Neptune/SF while TP
               led) are the classic trap: the level raises model EV, play follows the
               level, the fam still never closes — base strength alone never mints a
               target. 1-2 plays clear the take bar at 4; 3+/5+/8+ plays escalate the
               tie-break so filler levels land on the families we ACTUALLY grind
               (run 1793030565 last mega: Saturn 4-play Straight tied Mercury 8-play
               Two Pair at 4 and won by offer order, focal TP stayed L2; run
               1793032315: TP with 1 lifetime play banked two Uranus levels) */
            const played = ctx.played?.[f] ?? 0;

            /* no level ceiling: hands level past L7 for free in this build (3402 ran Pair
               to L11) - a filler planet on a L5+ grind fam scores like any other */
            if (!(played >= 1 && PLANET_GRIND.has(f))) {
                return 3;
            }

            /* FOCAL-FIRST (168: five level actions, four families, focal Pair stuck at L2
               into The Wall - multi-pick packs ate every filler planet while the grinding
               fam starved; same ladder formula as the shop floor, filler levels measured
               near-zero below the focal wall) */
            const fp = ctx.played?.[ctx.needFam] ?? 0;
            const fl = ctx.levels?.[ctx.needFam] ?? 1;

            if (fp >= 5 && fl < Math.min(4, 1 + Math.floor(fp / 4))) {
                return 3;
            }

            return played >= 8 ? 4.6 : played >= 5 ? 4.3 : played >= 3 ? 4.1 : 4; /* eslint-disable-line no-nested-ternary */
        }
        case 'tarot':
            /* Lovers is unusable dead stock in this build (see planTargeted gate) - score at
               the skip bar so it stops eating consumable slots out of packs */
            if (/lovers/i.test(`${o?.name} ${o?.key}`)) {
                return 3;
            }

            return TAROT_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 8 : 4;
        case 'spectral':
            return SPECTRAL_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 6 : 3;
        /* STANDARD-pack contents arrive as BARE enhancement items with no rank
           ('Glass Card','Mult','Lucky Card','Stone Card','Default Base') and fell to
           the rank-less default score 1 — 9 Enhanced contents were offered across the
           corpus and ZERO were taken (only the 7 plain 'Default Base' strays got
           picked up by a different path). Taking an enhancer adds a random base card
           with that enhancement (Default Base proved the take path works); permanent
           enhancements are pure upside even though the bridge hides enh state from
           prediction — Steel never breaks, Glass/Mult scale every hand that draws
           them; Stone can never be SELECTED, so it is dead weight, stay at 1 */
        case 'enhanced': {
            const n = String(o?.name ?? '').toLowerCase();

            if (/stone/.test(n)) {
                return 1;
            }

            if (/steel/.test(n)) {
                return 5;
            }

            if (/glass/.test(n)) {
                return 4.3;
            }

            if (/mult/.test(n)) {
                return 4.2;
            }

            return 4; /* lucky/bonus/wild/gold/round: positive-EV fillers */
        }

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

const SUIT_BY_TAROT = [['star', 'Diamonds'], ['moon', 'Clubs'], ['sun', 'Hearts'], ['world', 'Spades']];
const TARGET_RULES = [
    [/magician|empress|hierophant/i, 'top2'],
    [/tower/i, 'worst1'],
    [/devil/i, 'worst1'],
    [/chariot|justice|lovers|strength/i, 'best1'],
    [/hanged/i, 'trim2'],
];

/**
 * Target suit of a suit-conversion tarot (Star/Moon/Sun/World convert up to 3 selected cards;
 * NO submenu - the tarot fixes the suit). Effect text wins over the name map when present.
 *
 * @param {object} c - consumable observation
 * @param {string} nm - combined name+key string
 * @returns {string|null} suit name or null when not a suit tarot
 */
function suitTarget(c, nm) {
    const m = `${c.text || c.effect || ''}`.match(/diamonds|clubs|hearts|spades/i);

    if (m) {
        return m[0][0].toUpperCase() + m[0].slice(1).toLowerCase();
    }

    for (const [k, s] of SUIT_BY_TAROT) {
        if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`, 'i').test(nm)) {
            return s;
        }
    }

    return null;
}

/**
 * Descending-hand Death anchor: pick the right-most card of the highest duplicated
 * rank (all-distinct hands fall back to any card with a higher card on its left),
 * then the cheapest strictly-higher left card that Death should turn into it.
 *
 * @param {object[]} cards - selectable hand cards in table order
 * @returns {object[]|null} [left, right] or null when nothing qualifies
 */
function deathDescPair(cards) {
    const cnt = {};

    for (const c2 of cards) {
        cnt[rvOf(c2)] = (cnt[rvOf(c2)] || 0) + 1;
    }

    const dupRvs = Object.keys(cnt).map(Number).filter((r2) => cnt[r2] >= 2).sort((a, b) => b - a);

    for (let i = cards.length - 1; i >= 1; i--) {
        const right = cards[i];

        if (dupRvs.length && dupRvs[0] !== rvOf(right)) {
            continue;
        }

        const lefts = cards.slice(0, i).filter((x) => rvOf(x) > rvOf(right)).sort((a, b) => rvOf(a) - rvOf(b));

        if (lefts.length) {
            return [lefts[0], right];
        }
    }

    return null;
}

/**
 * One targeted direct-use tarot play for the current hand: caller selects cards then uses.
 * Table-driven: Magician/Empress/Hierophant top2 (Lucky/Mult/Bonus), Tower+Devil worst1
 * (Stone +50 / Gold money), Chariot(Steel)/Justice(Glass)/Lovers(Wild)/Strength(+1 rank) best1,
 * Hanged Man trims 2 junk (>=4 cards), Death needs a weaker card physically LEFT of the best
 * (left becomes copy of right by HAND position), Star/Moon/Sun/World convert up to 3 lowest
 * off-suit cards to the fixed suit. Suit commitment: once suitTally shows a committed suit
 * (>=2 conversions), non-matching converters are skipped so suits never oscillate back.
 *
 * @param {object} obs - hand-phase observation
 * @param {object} [suitTally] - this run's conversion counts per suit
 * @returns {object[]} at most one {target, cards, why} plan
 */
function planTargeted(obs, suitTally = {}) {
    /* Joker-target tarots: the card-target machinery below cannot express
       them. The Lovers copies a joker in most builds; 21+ Lovers holdings
       idled forever. Ankh (destroys the target joker) and Mothman are NOT
       safe guesses here, so only Lovers gets the flow. Use on the best
       scoring joker when a slot stands open. */
    /* Lovers in this build exposes only [sell/inspect] in every observed state and never
       copies passively at blind select or round end (3411: two rounds cleared, no duplicate)
       - gate on a real 'use' action so the branch stops firing 31x action_unavailable.
       If some future state grants 'use', the copy flow revives untouched. */
    const jkt = ((obs && obs.consumables) || []).find((c) => String(c.kind || '').toLowerCase() === 'tarot' && !c.face_down && !c.debuffed && (c.actions || []).includes('use') && /^(the lovers)$/i.test(c.name || ''));

    const jks = (obs && (obs.jokers || obs.jk)) || [];

    if (jkt && jks.length >= 2 && jks.length < 5) {
        const top = [...jks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

        if (top) {
            return [{ target: jkt.id, jid: top.id, why: `jkcopy ${jkt.name}->${top.name}` }];
        }
    }

    const cards = ((obs && obs.hand) || []).filter((c) => !c.debuffed && (c.actions || []).includes('select') && c.rank !== null && c.rank !== undefined && c.rank !== '');

    if (cards.length < 2) {
        return [];
    }

    const cons = ((obs && obs.consumables) || []).filter((c) => String(c.kind || '').toLowerCase() === 'tarot' && !c.face_down && !c.debuffed && ((c.actions || []).includes('use') || (c.actions || []).includes('inspect')));
    const byRv = [...cards].sort((a, b) => rvOf(b) - rvOf(a));
    const suitCount = {};

    for (const c0 of cards) {
        const s0 = `${c0.suit || ''}`;

        if (s0) {
            suitCount[s0] = (suitCount[s0] || 0) + 1;
        }
    }

    const topSuit = Object.entries(suitCount).sort((a, b) => b[1] - a[1])[0];
    const flushSuit = topSuit && topSuit[1] >= 4 ? topSuit[0] : null;
    let plan = null;

    for (const c of cons) {
        const nm = `${c.name || ''} ${c.key || ''}`;

        if (/wheel/i.test(nm)) {
            // untargeted: planConsumables uses it; selecting cards for it is noise
            continue;
        }

        const suit = suitTarget(c, nm);

        if (suit) {
            const commit = Object.entries(suitTally).sort((a, b) => b[1] - a[1])[0];

            if (commit && commit[1] >= 2 && suit !== commit[0]) {
                continue;
            }

            const off = cards.filter((x) => `${x.suit || ''}`.toLowerCase() !== suit.toLowerCase()).sort((a, b) => rvOf(a) - rvOf(b)).slice(0, 3);

            if (off.length) {
                plan = { target: c.id, cards: off, why: `suit->${suit}` };
                break;
            }

            continue;
        }

        if (/death/i.test(nm)) {
            /* DEATH-CLONE v3 (deathdiag capture 1793077710: hands arrive rank-DESCENDING
               and v2's "weaker card left of stronger" scan found no pair on ANY real hand
               - 19+ idled holds across 75486/7709). Death copies the RIGHT card onto the
               LEFT positionally. First try the ascending case (weaker left promoted onto
               a stronger right); if the hand is descending, ANCHOR the duplicated rank
               (the focal pair/trips) and demote the cheapest strictly-higher left card
               into it: junk 4 next to a pair of 2s becomes a third 2. With all-distinct
               ranks the same rule pairs the 2nd-best card under the best (K,Q -> QQ). */
            let pair = null;

            for (const right of byRv) {
                const pi = cards.indexOf(right);
                const left = cards.slice(0, pi).filter((x) => rvOf(x) < rvOf(right)).pop();

                if (left) {
                    pair = [left, right];

                    break;
                }
            }

            if (!pair) {
                pair = deathDescPair(cards);
            }

            if (pair) {
                plan = { target: c.id, cards: pair, why: 'death leftcopy->best' };

                break;
            }

            continue;
        }

        for (const [re, mode] of TARGET_RULES) {
            if (!re.test(nm)) {
                continue;
            }

            if (mode === 'top2' && byRv.length >= 2) {
                plan = { target: c.id, cards: byRv.slice(0, 2), why: 'enhance top 2' };
            } else if (mode === 'worst1') {
                plan = { target: c.id, cards: [byRv[byRv.length - 1]], why: 'stone/gold junk' };
            } else if (mode === 'best1') {
                /* Steel (Chariot) / Glass (Justice) boost the WHOLE scoring card: with a
                   flush-shape suit (>=4 cards) in hand, enhance that suit's best card -
                   a steel card outside the flush suit only scores in isolation */
                const steel = /chariot|justice/i.test(nm) && flushSuit;
                const pick = steel
                    ? cards.filter((x) => `${x.suit || ''}`.toLowerCase() === `${flushSuit}`.toLowerCase()).sort((a, b) => rvOf(b) - rvOf(a))[0] || byRv[0]
                    : byRv[0];

                plan = { target: c.id, cards: [pick], why: steel && pick !== byRv[0] ? 'enhance best flushsuit' : 'enhance best' };
            } else if (mode === 'trim2' && cards.length >= 4) {
                plan = { target: c.id, cards: byRv.slice(-2), why: 'trim 2 junk' };
            }

            break;
        }

        if (plan) {
            break;
        }
    }

    return plan ? [plan] : [];
}

export {
    classifyJoker, jokerOrder, chooseStrategy, famBiasMap, planConsumables, planTargeted, reorderNeeds, gateAllows,
    dominantSuit, scorePackOffer, PLANET_KEY, PLANET_NAME, PLANET_GRIND, TAROT_AUTO, SPECTRAL_AUTO,
};
