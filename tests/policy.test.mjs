/* Selftest chunk: Tarot plans, gate, pack scoring, planet targeting (split from the monolith 10-29; run via selftest.mjs). */
import { tHand } from './support.mjs';

/**
 * Tarot plans, gate, pack scoring, planet targeting assertions; throws on first failure.
 */
export async function runPolicy() {
    const { planetFam } = await import('../lib/planets.mjs');
    const { nextPlanetNeed } = await import('../lib/planetneed.mjs');
    const { chooseStrategy, famBiasMap, gateAllows } = await import('../lib/strategy.mjs');
    const { planTargeted } = await import('../lib/tarot.mjs');
    const { scorePackOffer } = await import('../lib/pack.mjs');
    const { JUNK_JOKER } = await import('../lib/jokers.mjs');

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

    /* GAMEFAM attribution probe: direct level diff, pack-phase pending flush,
       and no phantom attribution while the level table is unchanged */
    const { lvSnap, noteLv, flushLv } = await import('../lib/planetneed.mjs');
    const { resetShopRun } = await import('../lib/shop.mjs');
    const gfb = lvSnap({ hands: [{ name: 'Pair', level: 1 }, { name: 'Flush', level: 2 }] });

    if ((noteLv('Mercury', 'buy', gfb, [{ name: 'Pair', level: 2 }, { name: 'Flush', level: 2 }]) || []).join() !== 'Pair') {
        throw new Error('gamefam probe must attribute the bought level to the family that bumped');
    }

    resetShopRun();

    if (noteLv('Venus', 'pack', gfb, []) !== null || (flushLv([{ name: 'Pair', level: 1 }, { name: 'Flush', level: 3 }]) || []).join() !== 'Flush') {
        throw new Error('pack pending must defer then attribute the flush-observed bump');
    }

    resetShopRun();

    if (noteLv('Mars', 'pack', gfb, null) !== null || flushLv([{ name: 'Pair', level: 1 }, { name: 'Flush', level: 2 }]) !== null) {
        throw new Error('unchanged levels must not attribute anything');
    }

    /* DNA farm target (deck-engine rule) */
    const { dnaFarmPick } = await import('../lib/play.mjs');

    const fc = (rank, suit, key) => ({ id: 9, rank, suit, actions: ['select'], key });

    const farmHand = [fc('K', 'Hearts', 'c_base'), fc('A', 'Spades', 'm_mult'), fc('4', 'Clubs', 'm_steel')];

    const fp = dnaFarmPick(farmHand, 2, 2.0);

    if (!fp || fp.enh !== 'steel' || fp.card.rank !== '4') {
        throw new Error(`dnaFarmPick must farm the steel first at any capacity, got ${JSON.stringify(fp && fp.enh)}`);
    }

    if (dnaFarmPick([fc('Q', 'Hearts', 'm_glass')], 2, 1.1) !== null) {
        throw new Error('glass farm must demand spare capacity (1.1 < 1.35)');
    }

    if ((dnaFarmPick([fc('Q', 'Hearts', 'm_glass')], 2, 1.5) || {}).enh !== 'glass') {
        throw new Error('glass farm must fire with headroom');
    }

    if (dnaFarmPick(farmHand, 4, 2.0) !== null) {
        throw new Error('ante>3 must never farm (targets eat the hands)');
    }

    const fd = dnaFarmPick([fc('5', 'Hearts', 'm_mult'), { id: 8, rank: 'A', suit: 'Diamonds', actions: ['select'], key: 'm_mult', debuffed: true }], 1, 2);

    if (!fd || fd.card.rank !== '5') {
        throw new Error('debuffed cards must not be farm targets (copy of a dead card)');
    }

    if (dnaFarmPick([fc('7', 'Hearts', 'c_base'), fc('9', 'Clubs', 'm_bonus')], 1, 2) !== null) {
        throw new Error('bonus/vanilla cards are not farm targets');
    }
}
