/* Selftest chunk: Named joker semantics (split from the monolith 10-29; run via selftest.mjs). */
import { C, tabHC } from './support.mjs';

/**
 * Named joker semantics assertions; throws on first failure.
 */
export async function runJokerEffects() {
    const { predict, ctxOf, allSubsetEvals } = await import('../lib/play.mjs');
    const { jokerFactor, jokerSig } = await import('../lib/knowledge.mjs');

    /* Baron: X(extra)=X1.5 per held-not-played King (312/208=1.50 measured); needs hand */
    const baronJ = [{ name: 'Baron', values: { x_mult: 1, extra: 1.5 } }];
    const baronHand = [C('K', 'Hearts'), C('K', 'Spades'), C('Q', 'Diamonds'), C('4', 'Clubs')];
    const baronPlay = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: baronHand });
    const baronNoHand = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: [] });

    if (predict(tabHC, 'High Card', [C('Q', 'Spades')], baronPlay).score !== 34) {
        throw new Error(`baron two held Kings X1.5^2 must apply (15*2.25=33.75->34), got ${predict(tabHC, 'High Card', [C('Q', 'Spades')], baronPlay).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], baronPlay).score !== 23) {
        throw new Error(`played King must not count for baron (1 held, 15*1.5=22.5->23), got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], baronPlay).score}`);
    }

    if (predict(tabHC, 'High Card', [C('Q', 'Spades')], baronNoHand).unc !== true) {
        throw new Error('baron without hand snapshot must mark uncertain, never train a phantom boost');
    }

    /* Played NON-SCORING King kicker still leaves the hand: Pair of 8s played with a K
       kicker must count 1 held King (hand has 2), not 2 — candidate path through
       allSubsetEvals must disagree between the 2-card and 3-card plays */
    const baronTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const baronCards = [
        { ...C('K', 'Hearts'), id: 0, actions: ['select'] },
        { ...C('K', 'Spades'), id: 1, actions: ['select'] },
        { ...C('8', 'Hearts'), id: 2, actions: ['select'] },
        { ...C('8', 'Spades'), id: 3, actions: ['select'] },
        { ...C('5', 'Clubs'), id: 4, actions: ['select'] },
    ];
    const baronCtx = ctxOf({ jokers: baronJ, run: { discards_left: 1 }, hands: [], hand: baronCards });
    const baronEv = allSubsetEvals(baronCards, baronTab, null, baronCtx);
    const pairNoK = baronEv.find((x) => x.fam === 'Pair' && x.cards.length === 2);
    const pairKick = baronEv.find((x) => x.fam === 'Pair' && x.cards.length === 3 && x.cards.some((c) => c.rank === 'K'));

    if (!pairNoK || pairNoK.pred !== 117) {
        throw new Error(`baron pair without played K must score 26*2*2.25=117, got ${pairNoK?.pred}`);
    }

    if (!pairKick || pairKick.pred !== 78) {
        throw new Error(`baron pair with played K kicker must score 26*2*1.5=78, got ${pairKick?.pred}`);
    }

    /* Crimson Heart (random joker disabled every hand): single-joker engine EV
       must drop to the jokerless score; two-copy engine keeps half its value */
    const chTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const chHand = [
        { ...C('K', 'Hearts'), id: 10, actions: ['select'] },
        { ...C('K', 'Spades'), id: 11, actions: ['select'] },
        { ...C('3', 'Clubs'), id: 12, actions: ['select'] },
    ];
    const chFull = ctxOf({ jokers: [{ name: 'Joker', values: { mult: 30 } }], run: {} });
    const chOne = ctxOf({ jokers: [{ name: 'Joker', values: { mult: 30 } }], run: { blind: { name: 'Crimson Heart' } } });
    const chTwo = ctxOf({
        jokers: [{ name: 'Joker', values: { mult: 30 } }, { name: 'Joker', values: { mult: 30 } }],
        run: { blind: { name: 'Crimson Heart' } },
    });
    /**
     * Best Pair prediction for a context.
     *
     * @param {object} cx - decision context from ctxOf
     * @returns {number} pair prediction
     */
    const chPred = (cx) => allSubsetEvals(chHand, chTab, null, cx).find((x) => x.fam === 'Pair' && x.cards.length === 2).pred;
    const chP1 = chPred(chFull);
    const chP2 = chPred(chOne);
    const chP3 = chPred(chTwo);

    if (!(chP2 < chP1)) {
        throw new Error(`crimson heart must discount single-joker engine: ${chP2} vs full ${chP1}`);
    }

    if (chP3 !== chP1) {
        throw new Error(`crimson heart two-copy EV must equal one-copy full: ${chP3} vs ${chP1}`);
    }

    for (const k of Object.keys(jokerFactor)) {
        delete jokerFactor[k];
        delete jokerSig[k];
    }

    /* The Flint (build text "Base Chips and Mult are halved"): table base halves,
       card chips and joker layers join after — run 4202 Straight measured 516 vs the
       un-halved pred 1009 */
    const flintTab = [{ name: 'Straight', chips: 30, mult: 4, level: 1 }];
    const flintCtx = ctxOf({ jokers: [], run: { discards_left: 1, blind: { name: 'The Flint' } }, hands: [] });
    const flintPlain = ctxOf({ jokers: [], run: { discards_left: 1 }, hands: [] });
    const flintCards = [C('2', 'Spades'), C('3', 'Hearts'), C('4', 'Spades'), C('5', 'Hearts'), C('6', 'Spades')];

    if (predict(flintTab, 'Straight', flintCards, flintCtx).score !== 70) {
        throw new Error(`flint must halve base to (15+20)*2=70, got ${predict(flintTab, 'Straight', flintCards, flintCtx).score}`);
    }

    if (predict(flintTab, 'Straight', flintCards, flintPlain).score !== 200) {
        throw new Error('non-flint straight must stay (30+20)*4=200');
    }

    const flintEv = allSubsetEvals(flintCards.map((c, id) => ({ ...c, id, actions: ['select'] })), flintTab, null, flintCtx);

    const flintRow = flintEv.find((x) => x.fam === 'Straight' && x.cards.length === 5);

    if (!flintRow || flintRow.pred !== 70) {
        throw new Error(`candidate path must inherit flint halving, got ${flintRow?.pred} top=${flintEv.slice(0, 4).map((x) => `${x.fam}@${x.cards.length}:${x.pred}`).join(',')}`);
    }

    /* Joker Stencil: Xmult per empty slot, build publishes current X in x_mult
       (measured: lineup 1/5=>5, 3/3=>3, 5/5=>1) */
    const sten3 = ctxOf({ jokers: [{ name: 'Joker Stencil', values: { x_mult: 3 } }], run: { discards_left: 1 }, hands: [] });
    const sten1 = ctxOf({ jokers: [{ name: 'Joker Stencil', values: { x_mult: 1 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], sten3).score !== 45) {
        throw new Error(`stencil X3 from values must apply, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], sten3).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], sten1).score !== 15) {
        throw new Error('stencil X1 must be a no-op');
    }

    /* Flint rounding PIN (floor): odd base 5/1 -> floor 2/0. Official build floors;
       THIS build's text says only "halved" — live Flint run must confirm before the
       calibrate skip is lifted (skip currently protects both directions) */
    const flintOddTab = [{ name: 'High Card', chips: 5, mult: 1, level: 1 }];

    if (predict(flintOddTab, 'High Card', [C('K', 'Hearts')], flintCtx).score !== 0) {
        throw new Error(`flint floor pin: (2+11)*0=0, got ${predict(flintOddTab, 'High Card', [C('K', 'Hearts')], flintCtx).score}`);
    }

    /* Loyalty Card: X4 exactly on the hand observed with loyalty_remaining=0.
       Run 1793000317 boundary: remaining=1 play gained PLAIN (180 vs pred 195),
       remaining=0 (held across a discard) gained X4 (8064 = 2016x4); after firing
       the counter resets to `every`. The old "never fires" lesson was WRONG. */
    const loyFire = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 0 } }], run: { discards_left: 1 }, hands: [] });
    const loyOne = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 1 } }], run: { discards_left: 1 }, hands: [] });
    const loyCycle = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 }, loyalty_remaining: 3 } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyFire).score !== 60) {
        throw new Error(`loyalty X4 must fire on remaining=0, got ${predict(tabHC, 'High Card', [C('K', 'Hearts')], loyFire).score}`);
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyOne).score !== 15) {
        throw new Error('remaining=1 play must score PLAIN (measured 180, boost was one hand later)');
    }

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyCycle).score !== 15) {
        throw new Error('loyalty must stay off mid-cycle');
    }

    const loyBlind = ctxOf({ jokers: [{ name: 'Loyalty Card', values: { extra: { Xmult: 4, every: 5 } } }], run: { discards_left: 1 }, hands: [] });

    if (predict(tabHC, 'High Card', [C('K', 'Hearts')], loyBlind).unc !== true) {
        throw new Error('loyalty with no countdown field must mark the row uncertain, not guess');
    }
}
