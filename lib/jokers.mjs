/* jokers.mjs — joker KNOWLEDGE: shop/pack buy tiers, effect-text classification into
   scoring classes + family hints, ideal slot ordering, per-family bonuses, planet counts.
   Pure data + pure functions; the run-level decisions (which family to grind, what to
   buy) consume it from strategy/shop/pack. */

import { PLANET_KEY } from './planets.mjs';

/* Re-tiered 10-30b against the full-corpus full-5-board conditional census
   (n=368 boards at a4+, base P(deep)=0.405, game-verified joker sets from blind rows):
   promote only >=2SE names - Scary Face .58/36 joins Spare Trousers .76, Card Sharp .60,
   Fibonacci .64, Abstract .62 (Blue .55, Supernova .54 already in).
   Demote the decay/conditional bottom band out of STRONG - Ride the Bus .27/33,
   Runner .32/34, Mime .31/13, Baseball Card .20/10, Seance .20/5, Turtle Bean .17/6,
   Vagabond .25/4, Diet Cola/Popsicle (n<=5, vanilla decay-break items). Their morning
   promote came from a weaker all-runs metric (base .28); presence on a4+ boards is a
   weak-board marker, which is exactly what a BUY tier must not reward.
   obelisk JUNK (10-30 late): the confirmed build text (user oracle 10-29) says X0.2
   per hand ONLY while NOT the most-played family, RESETS to X1 when the most-played
   family is played -> permanently X1 for our single-family focal grind. The
   ORACLE 10-31 reclassification pair (both earlier readings were vanilla guesses):
   - Ride the Bus = +1 FLAT MULT (not Xmult) per consecutive hand WITHOUT a scoring
     face card, starts 0; growth lands in values.mult and is modeled there. The
     .27/33 census reading is a selection effect (weak boards = non-face hands).
   - Sixth Sense = UNCOMMON, grants a random SPECTRAL (never Soul/Black Hole) when
     the FIRST hand of a round plays a LONE 6; fires after scoring (survives debuff),
     no retrigger, needs the hand legal under boss. Lone 6 was NEVER played pre-10-31
     -> its 4/6 census cohort measured a dead joker; the farm rule (dnaFarmPick
     enh:'sixth') now feeds it; tier verdict deferred to a fresh post-farm cohort.
   'no-reset STRONG' note in this file was a vanilla misread; corpus agrees: 4/12 wins
   with it, and run 1793400510 bought it at a3 while focal-L3 needed a real xmult.
   Live-x_mult modeling in play.mjs stays (correct for any non-focused board).
   loyalty card kept strong: user-verified it DOES fire here (X4 every 6th hand).
   /i ADDED 10-30 (bug): display names arrive capitalized ('Obelisk','Scary Face') so the
   lowercase source regex NEVER matched and every STRONG joker silently scored tier 1;
   JUNK_JOKER always had /i. Fixing this promotes the intended names (+2 in shop/pack
   ranking) - counted as a gameplay-affecting change (mastery window re-based).
   JUNK rationale: actively harmful for our discard-heavy single-family grind: fewer
   hands / no discards / money traps; rocket: its +x_mult grows on SKIPPED boss blinds
   and this build has no skip phase (78698: sat at x1 all run). */
/* business card REMOVED 11-04 (game truth, tools/extract_jokers.mjs -> out/joker_truth.json):
   1-in-2 for $2 PER SCORING FACE CARD - our TP/face-heavy lineups print ~4 faces/blind,
   the strongest economy common in the pool; reclassified STRONG. */
/* conditional clan (droll/sly/wily/devious/crafty) DE-JUNKED 11-05: TRUTH cfg shows
   honest conditional adders ($4 R1, +50..100 chips / +8..12 mult on focal family) —
   their value is family-gated via COND_JOKER/famHint, not zero. */
const JUNK_JOKER = /half joker|credit card|burglar|fortune teller|red card|square joker|madness|rocket|obelisk|^the joker$/i;
/* ADDED 11-04 from game-truth extraction (blob 20 configs + blob 23 text, see
   tools/extract_jokers.mjs; numbers are this build's, not vanilla memory):
   the order/the tribe = X3 straight / X2 flush keyed sets (fam scoring carries them);
   bootstraps +2 mult per $5 (keepFloor cash converts to score); ride the bus +1/consecutive
   no-face hand (unbounded on 20+ hand blinds); mail-in rebate $ per rank-tagged discard
   (discard-heavy engine); burnt joker upgrades FIRST DISCARDED HAND each round (level
   economy = free planet); dna permanent deck copy (feeds Hologram/Steel); gros michel
   15 mult for $5 (destroy roll 1-in-6 acceptable raw EV); business card reclassified (junk note above). */
const STRONG_JOKER = /blueprint|brainstorm|the duo|the trio|the order|the family|the house|the mark|the tribe|the lumberjack|majestic|merry|sock|even steven|mystic|alt|banner|abstract|hologram|chicot|canio|triboulet|yorick|supernova|constellation|green joker|vampire|hit the road|the half|buster|smeared|ramen|fibonacci|pareidolia|scary face|\bmad\b|splash|nebula|ghost|dad|stuntman|walkie|cerb|blue joker|gray joker|sesquipedal|sixth sense|judgment|spirit|uncertainty|invisible|photograph|campfire|loyalty card|spare trousers|castle|card sharp|bootstraps|ride the bus|mail-in rebate|burnt joker|business card|dna|gros michel/i;

/**
 * Classify a joker name into a shop/pack tier.
 *
 * @param {string} name - joker display name (may be empty or missing)
 * @returns {number} 2 when STRONG_JOKER matches, 1 otherwise, 0 when the name is missing
 */
function jokerTier(name) {
    if (!name) {
        return 0;
    }

    return STRONG_JOKER.test(name) ? 2 : 1;
}

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

/* CONDITIONAL-FAMILY CLAN (11-05 TRUTH: out/joker_truth.json cfg `t_chips/t_mult +
   type=`, 11-05 forced-reload saga): the +N Chips/Mult IF-PLAYED-HAND-CONTAINS-X
   commons - the family I had junked (droll/sly/wily/devious/CRAFTY) or ignored
   (clever/jolly/zany/mad/crazy) under vanilla "weak conditional" lore. Build truth:
   CRAFTY = +80 chips on Flush CONTAINS, $4 R1 - for a Flush focal that is a real
   early adder; the whole clan is honest value when the focal family matches, junk
   when it does not. famHint -> jokerFamBonus +1.5 shop/pack scoring on focal match. */
const COND_JOKER = {
    'sly joker': { fam: 'Pair', chips: 50 }, 'jolly joker': { fam: 'Pair', mult: 8 },
    'clever joker': { fam: 'Two Pair', chips: 80 }, 'mad joker': { fam: 'Two Pair', mult: 10 },
    'wily joker': { fam: 'Three of a Kind', chips: 100 }, 'zany joker': { fam: 'Three of a Kind', mult: 12 },
    'devious joker': { fam: 'Straight', chips: 100 }, 'crazy joker': { fam: 'Straight', mult: 12 },
    'crafty joker': { fam: 'Flush', chips: 80 }, 'droll joker': { fam: 'Flush', mult: 10 },
};

/* NAME-based family hints: this build reports NULL effect text for these jokers
   (out/log.jsonl Splash rows: `["Splash",null,null,{...}]`), so fam is unparseable and
   the family scorer goes blind - run 207 held Splash, let Jupiter pass at Flush L1,
   died a5 CHIP_GAP. SPLASH FIXED 10-29 (user-confirmed text): Splash does NOT make
   cross-suit hands a Flush - it scores EVERY played card (incl seals/enhancements and
   joker triggers) on top of the real family - so overriding fam to Flush mis-scored
   calibration; real family now flows through and the bonus chips stay unmodelled
   (under-prediction = conservative). Four Fingers = flush with 4 cards (unverified,
   kept); Shortcut = gapped straights. */
const NAME_FAM = {
    'four fingers': 'Flush', shortcut: 'Straight',
    /* the number set IS family xmult (official texts name the family; build nulls
       them): famMatch+2 makes The Family/The Duo jump the ranking on a Two Pair focal
       (528/529 a4 tails: TP-L3 19-20 plays, no TP-engine joker, ~2k/hand vs 10k blind);
       spare trousers = +chips on TP-or-worse plays */
    'the duo': 'Two Pair', 'the family': 'Two Pair', 'the trio': 'Three of a Kind', 'spare trousers': 'Two Pair',
};

/* NAME-based class buckets: same NULL-effect-text build bug as NAME_FAM - without
   this every X-mult joker classifies 'unk', so the catBonus/mw xmult path never fires
   (a6 CHIP_GAP census: boards locked Cloud9/Castle/Stone by ante4, Ramen/Baron/
   Baseball Card/Photograph/Campfire confirmed in pool but never bought). Pool-verified
   names first; only true x_mult classics below (catBonus xmult=2 + mw). */
const NAME_CAT = {
    /* 'loyalty card': X4 Mult every 6th hand, oracle-confirmed 10-29 AND it FIRES in this
       build (live loyalty_remaining counter) - was classified unk, so an a6 death board
       (rid 1793569846) held a real xmult our scorer never credited. */
    'loyalty card': 'xmult', blueprint: 'xmult', brainstorm: 'xmult', 'the duo': 'xmult', 'the trio': 'xmult', 'the family': 'xmult', 'the house': 'util', 'the mark': 'util', obelisk: 'xmult', ramen: 'xmult', baron: 'xmult', 'baseball card': 'xmult', photograph: 'xmult', campfire: 'xmult', supernova: 'add', constellation: 'xmult', 'the half': 'xmult', 'ice cream': 'xmult', popsicle: 'xmult', cavendish: 'xmult', 'gros michel': 'xmult', canio: 'xmult', triboulet: 'xmult', yorick: 'xmult', mime: 'xmult', vampire: 'xmult', 'hit the road': 'xmult', smeared: 'xmult', 'spare trousers': 'chips',
    /* conditional clan (TRUTH cfg, 11-05): chips-branch = 'chips', mult-branch = 'add'
       (the additive-Mult bucket); famHint via COND_JOKER gates the value per focal. */
    'sly joker': 'chips', 'clever joker': 'chips', 'wily joker': 'chips', 'devious joker': 'chips', 'crafty joker': 'chips',
    'jolly joker': 'add', 'mad joker': 'add', 'zany joker': 'add', 'crazy joker': 'add', 'droll joker': 'add',
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

// how far apart the joker classes must sit in the ideal scoring order
const CAT_RANK = {
    chips: 0,
    add: 1,
    xmult: 2,
    econ: 3,
    util: 4,
    unk: 5,
};

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

    const nm = String(j?.name ?? '').toLowerCase();

    return { cat, famHint: fam ?? KEY_FAM[j?.key] ?? NAME_FAM[nm] ?? COND_JOKER[nm]?.fam ?? null };
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
            nm: `${j.name || ''} ${j.key || ''}`.toLowerCase(),
        });
    }

    tagged.sort((a, b) => a.rank - b.rank || a.slot - b.slot);

    /* COPY-JOKER PLACEMENT (oracle text 10-31, names corrected 11-05): Blueprint copies the joker IMMEDIATELY
       RIGHT of them — sit directly before the best copyable joker (our last/most-scarred
       X-mult). Brainstorm copies the LEFTMOST joker no matter where it sits — placement
       only matters to keep it OUT of slot 1 (dead there). Right-copies are never targets
       of each other. */
    /* 'crafty' REMOVED 11-05: vanilla lore called Brainstorm renamed-to Crafty here;
       TRUTH shows both exist (j_blueprint right-copy, j_brainstorm leftmost-copy) and
       j_crafty is the +80-chips Flush conditional - never a copier. */
    /**
     *
     * @param t
     */
    const isRightCopier = (t) => /blueprint/.test(t.nm);
    /**
     *
     */
    const bestTarget = () => {
        for (let i = tagged.length - 1; i >= 0; i--) {
            if (tagged[i].rank <= 2 && !isRightCopier(tagged[i])) {
                return i;
            }
        }

        return -1;
    };

    const copiers = tagged.filter(isRightCopier);

    if (copiers.length) {
        for (let i = tagged.length - 1; i >= 0; i--) {
            if (isRightCopier(tagged[i])) {
                tagged.splice(i, 1);
            }
        }

        const ti = bestTarget();

        if (ti < 0) {
            tagged.push(...copiers); // nothing copyable yet: park last
        } else {
            tagged.splice(ti, 0, ...copiers); // stack copies-of-copies onto the best target
        }
    }

    if (tagged.length > 1 && tagged[0] && /brainstorm/.test(tagged[0].nm)) {
        tagged.splice(1, 0, tagged.shift()); // slot 1 Brainstorm copies nothing
    }

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

export {
    JUNK_JOKER, COND_JOKER, jokerTier, classifyJoker, jokerOrder, jokerFamBonus, planetCounts,
};
