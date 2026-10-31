// shop.mjs — shop purchasing, booster packs, planet targeting.
import { observe, act } from './link.mjs';
import { policy, say, jw, buildFamilies } from './knowledge.mjs';
import { chooseStrategy, planConsumables } from './strategy.mjs';
import { PLANET_GRIND, PLANET_KEY, PLANET_NAME, PLANET_NAMES, planetFam } from './planets.mjs';
import { nextPlanetNeed, lvSnap, noteLv, flushLv, resetPending } from './planetneed.mjs';
import { openBooster, resetPackRun } from './packflow.mjs';
import { classifyJoker, jokerTier, JUNK_JOKER } from './jokers.mjs';
import { needPlan } from './need.mjs';

/**
 * Return the joker tier; junk names count as tier 0 so swaps sell them first.
 *
 * @param {(string | undefined)} n - joker name
 * @returns {number} tier (0 for junk)
 */
const tierOf = (n) => JUNK_JOKER.test(n || '') ? 0 : jokerTier(n);

/**
 * Return true when an item offers a given action.
 *
 * @param {object} it - shop or pack item
 * @param {string} a - action name
 * @returns {boolean} true when the item lists the action
 */
const has = (it, a) => (it.actions || []).includes(a);

/**
 * Return an item's kind lowercased.
 *
 * @param {object} it - shop or pack item
 * @returns {string} lowercased kind
 */
const kind = (it) => String(it.kind || '').toLowerCase();

/**
 * Return truthy when an item is a buyable planet card.
 *
 * @param {object} i - shop item
 * @returns {(boolean | string | null)} planetFam result when buyable
 */
const isPl = (i) => (has(i, 'buy_and_use') || has(i, 'buy')) && (kind(i) === 'planet' || PLANET_NAMES.has(i.name || '')) && planetFam(i);

/* supply vouchers (Planet Merchant / Telescope) already redeemed THIS RUN? Gates
   the SUPPLY-VOUCHER-HOLD floor below; resetShopRun() re-arms per run */
const supplyBought = new Set();

/**
 * Forget run-scoped purchase state (Planet Merchant) at the start of every run.
 */
function resetShopRun() {
    resetPending();
    supplyBought.clear();
    resetPackRun();
    huntBurn = 0;
}

/**
 * Buy planets, jokers, vouchers and packs in a shop run until nothing is left.
 *
 * @returns {Promise<object>} actions list plus a fresh observation
 */
async function handleShop() {
    const pol = policy();
    const actions = [];
    const failed = new Set();
    let money = 0;
    let loop = 0;
    /* COMMITTED SHOP TARGET (flip double-fire forensics 10-30, shopflip rows):
       every buy pass re-derives needFam from scratch, so the led-family flip fires
       on EVERY pass (same flip logged 2x per shop within ~300ms) and the intra-shop
       flip made the fresh target the flip's SOURCE each pass - tie-keep and the
       reroll-for-focal search then hunted the flip target's opposite (run
       1793394203: TP->FH flip lp5 vs cp2 fired 9x across passes, TP-L1 died a5).
       Commitment: when the strategy/volume signals are UNCHANGED since the last
       pass, keep the previously committed (post-flip) target; only a genuinely
       changed signal recomputes it. */
    /* resets with each new shop visit (while loop is per-visit); see COMMITTED SHOP TARGET */
    let needFamPrev = null;
    let needFamRawPrev = null;

    while (loop++ < 16) {
        const o = await observe();

        money = o.run?.money ?? 0;
        flushLv(o.hands);

        /* SHOP-ENTRY USE PASS (10-31 census: Hermit/Emperor only ever planned at
           blind-select, where skip-era money is $0-1 and the rich gate died; run
           1793419972 carried The Hermit to death by 559 chips). Money/utility
           tarots fire HERE, feeding the same shop's buys; targeted hand tarots
           stay on the in-hand planner (tarot.mjs), planets on buy_and_use. */
        if (loop === 1) {
            for (const plan of planConsumables(o, strat, { phase: 'shop', money })) {
                const it = (o.consumables || []).find((c) => c.id === plan.target);

                if (it?.actions?.includes('use')) {
                    const ru = await act({ epoch: o.epoch, action: 'use', target: it.id });

                    jw({ e: 'consuse', where: 'shop', why: plan.why, name: it.name, ok: ru.ok, code: ru.error?.code });
                }
            }
        }
        const items = (o.shop || []).filter((i) => !failed.has(i.id));
        const jLimit = (o.areas || []).find((a) => a.kind === 'jokers')?.limit ?? 5;
        const ownedJ = (o.jokers || []).length;
        const strat = chooseStrategy(o);
        const stratRow = (o.hands || []).find((h) => h.name === strat.fam);
        let needFam = null;

        if (strat.fam !== null) {
            const vol = nextPlanetNeed(o.hands);

            /* UNGRINDABLE strategy fams (Full House/4ok/SF never close on the RED
               profile) must never receive planets: run 1793033604 strategy-EV picked
               FH off ONE play (strong base), Earth x2 banked FH to L3, FH was then
               never played again and focal Straight died at L1, 1404 short of Wall */
            needFam = PLANET_GRIND.has(strat.fam) && (stratRow?.level ?? 1) < 9 ? strat.fam : vol?.f ?? null;

            /* VOLUME COMMITMENT (4 clean drift deaths 0659/1709/5442/6063: levels
               chased strategy-EV family while actual plays concentrated elsewhere,
               focal family died at L1 with 12-20 plays): when the most-played
               grindable family outplays strategy's pick by 2+, levels follow plays */
            if (PLANET_GRIND.has(strat.fam) && (stratRow?.level ?? 1) < 9 && vol && vol.f !== strat.fam && vol.played >= (stratRow?.played ?? 0) + 2) {
                needFam = vol.f;
            }
        } else {
            /* null strategy (raw-EV tie) must NOT blind the planet picks: run
               1793026551 bought 4 celestial packs with needFam null, scattered
               levels on Straight/Trips/High Card and its focal Two Pair (12 plays)
               died at level 1 — with no EV signal, follow the plays */
            needFam = nextPlanetNeed(o.hands)?.f ?? null;
        }

        /* DECISION-LOCAL commitment: TIE OR LEAD with a real sample (>=3 plays) flips the
           planet target onto the family we actually play. The old +1-lead blindfold cost
           19 policy-tax deaths in the era-64 A/B (policyTax 19 vs supplyTax 12): run
           1793108500 held a Four-Fingers-inflated EV target while Two Pair led plays from
           shop 1, took 3 scatter planets, starved focal TP to L1, died a4 at $0 - and
           starve-blocked two packs on the flipped target with no focal inside. joker hints
           are speculation until 3 plays; the play ledger is ground truth. */
        /* GLOBAL-LED WITHIN-ONE (fresh pair 2754/2755: nf=Flush all 14 shops while FH
           played 12>11, nf=Pair while TP 8>6 - strict lead-at-snapshot never fired
           because the focal surge completes AFTER the lead changes hands, then $13-24
           per shop bought Jupiter anyway): the play-max family anywhere in the table
           takes the target when it is at most ONE play behind needFam. Non-grind FH
           keeps the last-resort doctrine (>=4 plays); every other non-grind fam stays
           banned (x5-anomaly census: 4ok/SF never close on RED). */
        const famsNow = buildFamilies();
        const volNow = nextPlanetNeed(o.hands);

        /* COMMITMENT RESTORE (fix of the fix, c20a406 shipped the restore AFTER the
           flip so pass 2 re-fired the flip before restoring - shopflip rows showed
           first:1 AND first:0 pairs): with unchanged strategy/play-max signals the
           previously committed target is installed BEFORE any flip evaluation, so
           led.f !== needFam compares against the committed family and re-firing dies */
        const signalKey = `${strat.fam ?? null}|${String(volNow?.f ?? null)}`;

        if (needFamPrev !== null && needFamRawPrev === signalKey) {
            needFam = needFamPrev;
        }

        const rowsNow = famsNow.map((f) => {
            const r = (o.hands || []).find((h) => h.name === f);

            return { f, lvl: r?.level ?? 1, played: r?.played ?? r?.times_played ?? 0 };
        }).filter((r) => r.lvl < 9 && (PLANET_GRIND.has(r.f) || (r.f === 'Full House' && r.played >= 4)));
        const maxNow = Math.max(0, ...rowsNow.map((r) => r.played));
        const led = rowsNow.filter((r) => r.played === maxNow).sort((a, b) => famsNow.indexOf(a.f) - famsNow.indexOf(b.f))[0] ?? null;
        const curPlays = (o.hands || []).find((h) => h.name === needFam)?.played ?? 0;
        /* TIES KEEP THE COMMITTED TARGET: exact-tie with another family must not flip
           (5700: target FH at shop entry, loop-2 pass re-ran this block, famsNow tie-order
           named TP, mid-shop flip made Earth pack offers filler-score -> bought Mega at
           $4 with Earth inside and took NOTHING); nor may a grind fam steal FH on a tie
           (the very focal surge that minted the FH target keeps equal plays for shops) */
        const curGrind = PLANET_GRIND.has(needFam);
        const keepTie = led && led.played === curPlays && (curGrind || led.f !== 'Full House');

        if (led && led.f !== needFam && led.played >= 3 && !keepTie && led.played + 1 >= curPlays) {
            /* SUPPLY GATE (cohort-3 fix 10-30, shelfHasWant census: 6/6 flips post
               flip-churn-fix moved the hunt to a family whose planet was NOT on the
               shelf, and the runs died focal-L1 with the planet never arriving -
               Saturn/Jupiter/Venus flood packs while Uranus/Mercury are the scarce
               cards; led-surge is only worth following when its planet can actually
               be BOUGHT here): flip when the led planet is on this shelf, or when
               the current target's planet is NOT (strictly better to hunt a fed
               family than a starving one); else keep the committed target. */
            const wantKey = PLANET_KEY[led.f];
            const curKey = PLANET_KEY[needFam];
            const on = (k, fam) => Boolean(k) && items.some((i) => String(i.key || '').includes(k) || String(i.name || '') === PLANET_NAME[fam]);
            const fed = on(wantKey, led.f);
            const curFed = on(curKey, needFam);

            jw({ e: 'shopflip', from: needFam, to: led.f, lp: led.played, cp: curPlays, ante: o.run?.ante ?? null, first: loop === 1 ? 1 : 0, shelfHasWant: fed ? 1 : 0, curFed: curFed ? 1 : 0, gated: fed ? 0 : 1 });

            /* v2 (cohort read 10-30 late): the 54ea17e gate let through 12/12 flips onto
               UNFED targets (curFed is ~never 1 — shelf planets are rare — so the
               !curFed escape always fired) and focal-L1@death stayed 4/13. Commitment
               now holds unless the surge family's planet can actually be BOUGHT here. */
            if (fed) {
                needFam = led.f;
            }
        }

        /* FED-LEVEL LOCK (run 1793408837: TP->Flush flip at a2 stranded nothing then,
           but needFam later drifted BACK to TP while Flush sat at L2 - the run died a5
           gap 9165 with TP L4/Flush L2 and 9165 chips live in the stranded Flush; the
           flip gate v2 only guards the flip ITSELF, the volume-commitment path above
           re-derives needFam every pass and can strand fed levels anyway): levels are
           permanent and compound — the family holding the most banked levels (>=2,
           grindable, <L9) IS the target; plays and strategy-EV may not strand it */
        let fedF = null;
        let fedL = 1;

        for (const r of rowsNow) {
            if (PLANET_GRIND.has(r.f) && r.lvl >= 2 && r.lvl < 9 && r.lvl > fedL) {
                fedL = r.lvl;
                fedF = r.f;
            }
        }

        if (fedF && needFam !== fedF) {
            jw({ e: 'shopfeed', from: needFam, to: fedF, lvl: fedL, ante: o.run?.ante ?? null });
            needFam = fedF;
        }

        /* record the committed target for the next pass of THIS shop visit */
        needFamRawPrev = signalKey;
        needFamPrev = needFam;

        /* planets: exactly the family we actually play — off-family filler adds zero
           chips to the blind we grind (measured: Pluto/Mercury buys with Two Pair at
           level 1); the search below rerolls bounded for the right planet instead */
        const anteN = o.run?.ante ?? 1;

        /* pre-purchase snapshot (loop-1 only): forensics need the OFFERED shelf with
           prices, not just what remains after the buying loop drained it */
        if (loop === 1) {
            jw({
                e: 'shopdump',
                pre: 1,
                money,
                ante: anteN,
                /* nf: the exact family this shop hunts planets for (leak forensics) */
                nf: needFam,
                /* hb: hands-table snapshot [name, level, played] at THIS shop instant -
                   forensics could never replay the true play-ledger before (strategy
                   rows are sparse and post-blind), leak audits were blind-guesswork */
                hb: (o.hands || []).map((h) => [h.name, h.level ?? 1, h.played ?? h.times_played ?? 0]),
                /* FIELD-CENSUS: schema union + one raw Joker item sample - answers the
                   edition/negative observability question (can scoreJ bid on Foil /
                   Polychrome / Negative if the bridge ever exposes them) from the next
                   deep shop onward instead of a dedicated probe run */
                kx: [...new Set(items.flatMap((i) => Object.keys(i)))].join(','),
                rs: JSON.stringify(items.find((i) => i.kind === 'Joker') || {}).slice(0, 400),
                items: items.map((i) => ({
                    k: i.kind, n: i.name, c: i.cost, cat: i.kind === 'Joker' ? classifyJoker(i).cat : undefined, a: i.actions,
                    /* MAGIC TRICK & co: vouchers need their effect text logged once to justify
                       the $10 hold (buy 2/187+); ed: edition (holo/foil) rides the new schema
                       field seen on Buffoon offers - census only, no scoring change yet */
                    ef: i.kind === 'Voucher' ? (i.effect || i.ef || []).join('|') : undefined,
                    ed: i.edition || (i.values && i.values.edition) || undefined,
                })),
            });
        }

        let keepFloor = 0;

        if (anteN >= 5) {
            keepFloor = 13;
        } else if (anteN >= 3) {
            keepFloor = pol.minHold ?? 8;
        }

        /* SUPPLY-VOUCHER-HOLD: Planet Merchant ("Planet cards appear 2X more
           frequently in the shop") and Telescope ("Celestial Packs always contain the
           Planet card for your most played hand" — guarantee PROVEN 2/2 in 1623) are
           the run-permanent supply counters, and the loop drained past them at every
           shop ever measured (7579 PM x3 at $8/7/5/8; 162909 Telescope at $11 money —
           voucher prices VARY $10-12, so the floor is the item's OWN cost). Hold the
           cost while a supply voucher is offered and unredeemed — gated on owning a
           joker already (blind-clear insurance), which auto-skips the first ante-1 shop
           and then covers the 162909/3464 shape: PM/Telescope shelved at ante-1 shop 2
           with $11+, drained by a $4 joker before the voucher stage ever ran */
        const sv = items.find((i) => /planet merchant|telescope/i.test(i.name || '') && !supplyBought.has(String(i.name || '').toLowerCase()));

        if (sv && ownedJ >= 1 && money >= (sv.cost ?? 10)) {
            keepFloor = Math.max(keepFloor, sv.cost ?? 10);
        }

        /* FOCAL-STARVED release (1793070132 died -2766 with TP at 9 plays L1 and $10
           held idle: keepFloor 8 blocked the $4 Celestial and the $5 hunt reroll,
           junk jokers got bought instead): once the most-played grindable family has
           5+ plays and still sits L1 at ante 3+, release the lottery floor to $2 for
           the celestial pack and the hunt reroll ONLY - junk-joker EV is below a focal
           L2 roll, and off-family levels are measured to add zero */
        /* LADDERED v2 (era census: median FOCAL level at a5 death = 2 while the only
           a5 win had L11/35 plays - the a5+ wall is levels, not jokers, and lvl<=1 was
           too strict to ever fire at L2-after-20-plays (156). Target level grows with
           plays: ~2 per 4 plays, capped L4) */
        const lvlWant = Math.min(anteN >= 5 ? 8 : 4, 1 + Math.floor((volNow?.played ?? 0) / 4));
        const focalStarved = anteN >= 3 && volNow !== null && (volNow.played ?? 0) >= 5 && (volNow.lvl ?? 1) < lvlWant;

        /* LOOK-AHEAD (lib/need.mjs, user 10-31): blind targets roughly DOUBLE per ante;
           when 4 hands of our best known play can't cover TWO antes ahead, every dollar
           must go to score NOW — lottery rerolls stop, joker buys spend down to the item
           (the corpus dies at the a4 cliff one ante AFTER being "fine" at a3) */
        const nd = needPlan(anteN);

        if (loop === 1) {
            jw({ e: 'need', ante: anteN, best: nd.best, t2: nd.t2, crisis: nd.crisis ? 1 : 0, tight: nd.tight ? 1 : 0, money, jk: ownedJ });
        }

        const pl = items.find((i) => isPl(i) && needFam && planetFam(i) === needFam);

        if (pl) {
            const _lb = lvSnap(o);
            const r = await act({ epoch: o.epoch, action: has(pl, 'buy_and_use') ? 'buy_and_use' : 'buy', target: pl.id });

            if (r.ok) {
                say('shop: planet', pl.name);
                actions.push(`planet:${pl.name}`);
                noteLv(pl.name, 'buy', _lb, r.result && r.result.hands);
                huntBurn = 0;
                continue;
            }

            jw({ e: 'shopfail', what: pl.name, code: r.error?.code });
            failed.add(pl.id);
            continue;
        }

        /* SECOND-GRINDER PLANET (late-surge strand, n=2: 3994 TP 17p died L2 while
           levels followed the Flush/3ok leaders; 3055 TP 7p L1 with 3ok8 vol — Uranus
           $3 on the same $9 shelf, exact-only rule skipped it, TP surged to 11 after
           the LAST shop closed): a grinder within 2 plays of the leader is a surge
           candidate; planets cost $3 and the exact path has never had a money floor,
           so covering the runner-up at half a reroll's price is the cheapest hedge
           against the leader changing next ante */
        const grank = (o.hands || [])
            .filter((h) => PLANET_GRIND.has(h.name))
            .map((h) => ({ n: h.name, p: Number(h.played ?? h.times_played) || 0 }))
            .sort((a, b) => b.p - a.p);
        /* FOCAL-STARVED: the grind family is committed but behind its win-line level —
           at a3+ every $3 filler level lands on a family that will NOT clear the blind
           (run 1793408837: 3x Uranus into Flush L2 while focal TP died a5 at L4).
           Money instead serves the reroll hunt for the FOCAL planet */
        const fsDeep = anteN >= 3 && volNow !== null && (volNow.played ?? 0) >= 5 && (volNow.lvl ?? 1) < 5;

        const sec = anteN <= 4 && !fsDeep && grank.length > 1 && grank[0].p - grank[1].p <= 2 && grank[1].p >= 4 && grank[1].n !== needFam ? grank[1].n : null;
        const pl2 = sec ? items.find((i) => isPl(i) && planetFam(i) === sec && !actions.includes(`planet:${i.name}`)) : null;

        if (pl2) {
            const _l2 = lvSnap(o);
            const r2 = await act({ epoch: o.epoch, action: has(pl2, 'buy_and_use') ? 'buy_and_use' : 'buy', target: pl2.id });

            if (r2.ok) {
                say('shop: planet(2nd-grinder)', pl2.name);
                actions.push(`planet:${pl2.name}`);
                noteLv(pl2.name, 'buy2', _l2, r2.result && r2.result.hands);
                continue;
            }

            jw({ e: 'shopfail', what: pl2.name, code: r2.error?.code });
            failed.add(pl2.id);
        }
        /* strategy-scored joker buys (fam synergy / xmult / additive value);
           anteN/keepFloor already computed with the planets block above */

        const catBonus = { xmult: 1.5, chips: 0.8, add: 0.8, econ: 0.3 };
        /* MULT PRIORITY (5 CHIP_GAP a5+ deaths with chips-heavy lineups: 9806
           Wrathful/Gluttonous/Faceless, 9807 Jolly/Green, 1625 ScaryFace/Runner/Castle
           at TP L6 27 plays — levels maxed, blind still 2x score/hand): once a grind
           family passed 15 plays the run is committed to it, and only MULTIPLICATIVE
           pieces scale the per-hand score into ante-5 range; chips/add buys plateau.
           xmult offers jump the ranking; the +2 is capped to the 15+ cohort so early
           thin-mult games still take the chips joker (it buys the tempo to get there) */
        const fpMax = Math.max(0, ...(o.hands || []).filter((h) => PLANET_GRIND.has(h.name)).map((h) => Number(h.played ?? h.times_played) || 0));
        const mw = fpMax >= 15 ? 2 : 0;
        /* SWAP-IN v1 (64600: Ramen xmult sat on the $6 shelf through ante-3 while all
           five slots held decayables (Popcorn/Ice Cream) - the ownedJ<jLimit filter hid
           every non-legendary offer from the sell-weakest retry path at 477). Full slots
           no longer blind the scan: an offer must beat the OWNED weakest by 0.8 to earn
           a sell, so 3.0 fillers cannot churn a Blueprint-class engine */
        /**
         * Fraction of life left in THIS BUILD's consumable jokers (Ramen x_mult 2->0,
         * Ice Cream extra.chips 100->0, Popcorn mult 20->0, Turtle Bean extra.h_size 5->0;
         * 66896: Ramen decayed out by ante-4). NAME-GATED: the value counters are generic
         * shapes and false-matched Even Steven/Runner/Castle/Golden/Seltzer (2600+ ticks)
         * on the first deploy - shape stays only as a type guard.
         *
         * @param {object} j - owned joker observation with values
         * @returns {number} remaining-life fraction 0..1 (1 for non-decaying)
         */
        const decayF = (j) => {
            const v = j.values;

            if (!v) {
                return 1;
            }

            const n = `${j.name || ''}`;

            if (n === 'Ramen' && typeof v.x_mult === 'number') {
                return Math.min(1, Math.max(0, v.x_mult / 2));
            }

            if (n === 'Ice Cream' && v.extra && typeof v.extra.chips === 'number') {
                return Math.min(1, Math.max(0, v.extra.chips / 100));
            }

            if (n === 'Popcorn' && typeof v.mult === 'number') {
                return Math.min(1, Math.max(0, v.mult / 20));
            }

            if (n === 'Turtle Bean' && v.extra && typeof v.extra.h_size === 'number') {
                return Math.min(1, Math.max(0, v.extra.h_size / 5));
            }

            return 1;
        };

        /* SPECIAL-FLAG FACTORS (field census b8410a1: items carry eternal/rental/
           perishable - real fields, unpriced until now): eternal cannot be sold or
           rerolled away (no resale value), rental bills ~$3 per interest round,
           perishable self-destructs after N rounds. The OUT side already filters on
           the 'sell' action (eternal-safe); only the buy-side price needs the haircut */
        /**
         * Price haircut for special-flag jokers.
         *
         * @param {object} j - item or owned joker row
         * @returns {number} multiplicative factor <= 1
         */
        const specF = (j) => (j.eternal ? 0.75 : 1) * (j.rental ? 0.7 : 1) * (j.perishable ? 0.6 : 1);

        /**
         * Score an OWNED joker with the shop-offer formula so swaps compare like for like.
         *
         * @param {object} j - owned joker observation
         * @returns {number} comparable joker score
         */
        const scoreJ = (j) => {
            const { cat, famHint } = classifyJoker(j);

            return (2 + (famHint && famHint === strat.fam ? 2 : 0) + (catBonus[cat] || 0) + (cat === 'xmult' ? mw : 0) + tierOf(j.name) * 0.3) * decayF(j) * specF(j);
        };

        const ownedSc = (o.jokers || []).map(scoreJ);
        const weakS = ownedSc.length ? Math.min(...ownedSc) : 0;

        /* STENCIL SLOT ECONOMY (measured across 43998/71855/72635/72638: values.x_mult
           tracks 1 + EMPTY joker slots - x5 at jk1, x2 at jk4, x1 at jk5): the last
           slot is worth one whole Xmult step to Stencil, so ordinary mid-tier filler
           (s<4.5) may not fill it; elite buys and the swap path are unaffected.
           The 3998 lesson (died with ONE joker) still holds - slots 1..4 keep the
           engine-starved floors exactly as-is */
        const stXm = Math.max(1, ...(o.jokers || []).filter((j) => j.name === 'Joker Stencil').map((j) => (j.values && j.values.x_mult) || 1));
        let fillMin = 3;

        if (ownedJ <= 2) {
            fillMin = 2;
        } else if (stXm >= 2 && ownedJ >= jLimit - 1) {
            fillMin = 4.5;
        }

        /* FULL-SLOT BUY BLINDNESS (478 a5: Supernova xmult $5 on the shelf, $15 banked,
           actions=["inspect"] ONLY - this build strips 'buy' from joker items while the
           joker area is full, so has(buy) emptied `scored` and the sell-weakest swap
           below never ran): with full slots an inspect-only joker is a swap CANDIDATE;
           the buy attempt fails (no verb), the sell frees the slot, and next loop the
           shelf item re-exposes 'buy' */
        const scored = items
            .filter((i) => kind(i) === 'joker' && !JUNK_JOKER.test(i.name || '') && (has(i, 'buy') || (ownedJ >= jLimit && has(i, 'inspect'))))
            .map((i) => {
                const { cat, famHint } = classifyJoker(i);
                /* FAMILY-DRIFT PENALTY (era census: family-pinned jokers bought 25 OFF
                   vs 10 match to the run focal - Zany's +12 never fires on a Two Pair
                   run, Droll's on a Pair run): off-family mult jokers are dead weight
                   that still eat the slot; nudge them below mid-tier generic filler */
                const famMatch = famHint && famHint === strat.fam ? 2 : 0;
                const famOff = famHint && strat.fam && famHint !== strat.fam ? -1 : 0;
                /* DECK-ENGINE SYNERGY: Stone Joker pays +25 chips PER PERMANENT card
                   added to the deck, and the farm engine (DNA copy / lone-6 Sixth Sense
                   spectral feeding) is the corpus's only deck-growth channel — Stone
                   was confirmed in the pool but never bought (a6 census) while boards
                   farmed copies unpunished. Pair the two halves in either direction. */
                const ownEng = (o.jokers || []).some((j) => /DNA|Sixth Sense/i.test(j.name || ''));
                const ownStone = (o.jokers || []).some((j) => /Stone Joker/i.test(j.name || ''));
                const synergy = (/Stone Joker/i.test(i.name || '') && ownEng) || (/\bDNA\b|Sixth Sense/i.test(i.name || '') && ownStone) ? 2.5 : 0;

                return { i, s: (2 + famMatch + famOff + (catBonus[cat] || 0) + (cat === 'xmult' ? mw : 0) + tierOf(i.name) * 0.3 + synergy) * specF(i) };
            })
            /* engine-starved (3998: 20p Pair L3, 11 buyable non-junk shop items across
               a2-a4, s>=3 skipped every Green/Raised-Fist-class filler, died on the
               Needle with ONE joker): an empty slot is strictly worse than verified
               mid-tier — JUNK_JOKER still blocks the true junk, and the sell-weakest
               swap path below keeps slots reclaimable. CRISIS completes it (run
               1793414824: died a4 gap 3578 with 2 open slots and $40 holding while
               weak-but-real shop jokers sat at s<fillMin): the near-miss band is
               ~300-400 chips = exactly Raised-Fist-class output, take ANY non-junk */
            .filter((x) => ownedJ < jLimit ? x.s >= (nd.crisis ? 1 : fillMin) : x.s >= weakS + 0.8)
            .sort((a, b) => b.s - a.s);
        /* ELITE-BUY OVERRIDE (30575-era jkpass capture: Ramen Joker, score 5.8 xmult —
           best joker seen all era — skipped at a3 because money 13 - cost 6 < the $8
           keepFloor; run died at that same ante needing ~2k/hand more): keepFloor
           protects the reroll/pack lottery, but a 5+ joker beats any lottery ticket.
           Spend down to the joker itself; sell-swap still guards slots downstream */
        /* MID-BAND EXEMPTION v3 (post-red-bundle census: 10 jkpass rows at a3-a4,
           6 of them skipped while $1-3 short of the v2 $4-left bar — and those runs
           died at those same antes 300-2400 chips SHORT, the saved money going to
           EMPTY rerolls; this build pays NO interest, so leftover cash is score
           already lost): a guaranteed s>=3 joker needs NOTHING left — unless a
           supply voucher is pending, where the hold floor stays king (PM/Telescope
           outvalue any 3.x filler; the multi-shop hold conversion 3058154 must not
           regress); s>=5 stays floorless and the s<3 filler band keeps keepFloor */
        let jkFloor = keepFloor;

        if (scored.length && (nd.crisis || scored[0].s >= 5 || (scored[0].s >= 3 && !sv))) {
            jkFloor = 0;
        }

        const jk = scored.length && money - (scored[0].i.cost ?? 4) >= jkFloor ? scored[0].i : null;

        const jkS = jk && scored.length ? scored[0].s : 0;

        /* diagnostic (30995: Photograph $5 STRONG on a $14 shelf, never bought, run
           died a2 with ONE joker): log every rotation where a joker cleared the bar
           but did not get bought, and every pack bought ahead of a pending joker */
        if (scored.length && !jk) {
            jw({
                e: 'jkpass', n: scored[0].i.name, s: scored[0].s, cost: scored[0].i.cost ?? 4, money, floor: keepFloor, ante: anteN, ownedJ,
            });
        }

        /* Celestial packs are the guaranteed-ish planet pipeline (3+ random choices;
           with Telescope the pack always carries the most-played fam's planet — ef text
           confirms, packdump telemetry will verify): buy+open BEFORE the single-slot
           reroll lottery — funnel showed 16 hunt rerolls buying 0 planets vs 19 picks */
        /* JOKER-OVER-PACK v2 (3053: $4 pack drained the $4 Clever window, died a2
           with ONE joker; 3057416 packfirst capture proved the ROTATION half — Banner
           sat on the $17 shelf, the pack bought "with room to spare" was opened, and
           the post-pack ef dump showed the joker slot REROLLED: Banner was simply
           gone. Money-fitting the pack is not enough when opening a booster rotates
           shelf slots; a real buy (s>=3) claims the rotation outright and the pack
           waits for a shelf visit of its own — pack supply (4-pick contents, PM,
           Telescope) is renewable, shelf jokers are not. Filler-band jokers (s<3)
           keep the old money-fit clause so packs still flow when the joker is junk-
           adjacent; early packs keep the $8 reserve up to 2 owned jokers */
        let cpFloor = ownedJ <= 2 && anteN <= 2 ? 8 : keepFloor;

        if (focalStarved) {
            cpFloor = 2;
        }

        const cp = needFam !== null && items.find((i) => kind(i) === 'booster' && /celestial/i.test(i.name || '') && has(i, 'use') && wantPack(i, o) && money - (i.cost ?? 4) >= cpFloor && (!jk || focalStarved || (jkS < 3 && money - (i.cost ?? 4) - (jk.cost ?? 4) >= keepFloor)));

        if (cp) {
            say('shop: celestial pack', cp.name);

            if (jk) {
                jw({
                    e: 'packfirst', jk: jk.name, s: jkS, jkc: jk.cost ?? 4, packc: cp.cost ?? 4, money, floor: keepFloor,
                });
            }

            if (await openBooster(o, cp, needFam, actions)) {
                continue;
            }

            failed.add(cp.id);
            continue;
        }

        /* no planet, no celestial pack? bounded reroll hunt BEFORE discretionary buys —
           ante 2+, none bought this shop, max 2 tries, floor (>= $6) banked after the
           ~$5 cost; 1/9-type card odds are poor, packs above carry the pipeline */
        const rrh = (o.controls || []).find((c) => c.enabled && /reroll/i.test(c.kind));
        const pB0 = actions.filter((a) => a.startsWith('planet')).length;
        const rrT0 = actions.filter((a) => a === 'reroll').length;

        if (jk) {
            const r = await act({ epoch: o.epoch, action: 'buy', target: jk.id });

            if (r.ok) {
                say('shop: joker', jk.name);
                actions.push(`joker:${jk.name}`);
                continue;
            }

            if (ownedJ < jLimit) {
                jw({ e: 'shopfail', what: jk.name, code: r.error?.code });
                failed.add(jk.id);
                continue;
            }

            // slots full: sell the single weakest owned joker, then retry the buy once
            const weak = (o.jokers || []).filter((j) => (j.actions || []).includes('sell')).sort((a, b) => scoreJ(a) - scoreJ(b))[0];

            if (weak) {
                const o2 = await observe();
                const rs = await act({ epoch: o2.epoch, action: 'sell', target: weak.id });

                if (rs.ok) {
                    say('shop: sell', weak.name, 'for', jk.name);
                    actions.push(`sell:${weak.name}`);
                    continue;
                }
            }

            jw({ e: 'shopfail', what: jk.name, code: r.error?.code });
            failed.add(jk.id);
            continue;
        }

        /* no planet and no wanted joker in this rotation? bounded reroll hunt (max 2 —
           a 3rd exact-planet lottery is deferred until the joker-first ordering is
           measured: a miss rotates away joker/pack offers, 1/9 per $5 was 16/0 once) */
        /* HUNT BURNOUT (624: 8 hunt rerolls over 4 shops, $40, ZERO planets - the
           1/9 lottery stays dead once supply runs dry; after 4 fruitless hunt rerolls
           in a run the shelf is clearly planetless, stop until one lands) */
        /* SURPLUS SWEEP (655 died at the 22k Wall with $95 idle; a4-a5 forensics keep
           finding $65-95 cash dying to score walls - this build pays NO interest, cash
           past ~$30 at a3+ is score left unspent; deep shops sweep up to 5 rotations
           hunting the mult joker/planet the shelf is withholding, huntBurn still caps
           the dead-lottery downside) */
        const rrWant = money >= 30 && anteN >= 3 ? 5 : 2;

        if (rrh && !(nd.crisis && money < 14) && pB0 === 0 && needFam !== null && !actions.some((a) => a.startsWith('pack:') && /celestial/i.test(a)) && rrT0 < rrWant && huntBurn < (rrWant > 2 ? 8 : 4) && (o.run?.ante ?? 1) >= 2 && money - 5 >= (focalStarved ? 2 : Math.max(keepFloor, 6))) {
            const rh = await act({ epoch: o.epoch, action: 'activate', target: rrh.id });

            if (rh.ok) {
                say('shop: hunt-planet reroll');
                actions.push('reroll');
                huntBurn++;
                continue;
            }
        }

        // 3) vouchers we like ('use' redeems)
        /* ef effect-text telemetry settles the voucher questions with the game's OWN
           wording: 'Planet Merchant' = "Planet cards appear 2X more frequently in the
           shop" — the direct lever for the supply-starve death class (7957/2315/4476/
           5659/6364/6947: focal planet absent all run); it was never listed (6364 passed
           two offers). 'Telescope' RESTORED — ef text matches the official guarantee
           ("Celestial Packs always contain the Planet card for your most played hand")
           and the earlier 22/46 "it doesn't work" tally was invalid: every Telescope buy
           predates the first packdump event, so the guarantee was never observable */
        /* DECK-SHAPING VOUCHERS v2 (a4+ stock census: deep shops DO stock these - old
           'never stocked' census used the wrong item field): Paint Brush = first played
           card levels up every hand (permanent scaling card); Magic Trick = +mult/+chips
           AND a red seal on a hand card (the ONLY seal supplier we ever see); Tarot
           Merchant = 2X tarot stock (feeds the enhancement engine); Wasteful = +1 discard
           (card accumulation: more discards = better final hand); Hieroglyph deliberately
           OUT (-1 hand for $2 tarots) */
        const vlist = pol.vouchers || ['Planet Merchant', 'Telescope', 'Overstock', 'Clearance Sale', 'Director\'s Cut', 'Retcon', 'Grabber', 'Seed Money', 'Crystal Ball', 'Hone', 'Warp Time', 'Paint Brush', 'Magic Trick', 'Tarot Merchant', 'Wasteful'];
        const vc = items.find((i) => kind(i) === 'voucher' && (has(i, 'use') || has(i, 'buy')) && vlist.some((v) => (i.name || '').includes(v)));

        if (vc) {
            const r = await act({ epoch: o.epoch, action: has(vc, 'use') ? 'use' : 'buy', target: vc.id });

            if (r.ok) {
                say('shop: voucher', vc.name);
                actions.push(`voucher:${vc.name}`);

                if (/planet merchant|telescope/i.test(vc.name || '')) {
                    supplyBought.add(String(vc.name || '').toLowerCase());
                }

                continue;
            }

            jw({ e: 'shopfail', what: vc.name, code: r.error?.code });
            failed.add(vc.id);
            continue;
        }

        // 3.5) tarots: cheap permanent deck enhancement; needs free slot + keepFloor
        const ca = (o.areas || []).find((a) => a.kind === 'consumeables');
        const slotFree = (ca?.limit ?? 2) - ((o.consumables || []).length);
        /* zero jokers before ante 3: money goes to jokers first (a1 deaths measured at
           51-72 short with <=1 joker) — EXCEPT Judgement, which creates a Joker outright
           and is the recovery path for exactly these broke-and-slotless runs */
        const earlyOk = ownedJ > 0 || anteN >= 3;
        /* DEEP-SURPLUS: at a3+ with $30+ in hand the reroll lottery is a worse deck
           improvement than a $3 tarot (a4-a5 forensics: $65-$90 cash died through the
           ante while jokers stocked below the buy bar) - drop the keepFloor guard */
        const tcFloor = anteN >= 3 && money >= 30 ? 0 : keepFloor;
        const tc = slotFree > 0 && items.find((i) => kind(i) === 'tarot' && has(i, 'buy') && (earlyOk || /judgement/i.test(`${i.name || ''}`)) && !/fool|temperance|lovers/i.test(`${i.name || ''}`) && money - (i.cost ?? 3) >= tcFloor);

        if (tc) {
            const r = await act({ epoch: o.epoch, action: 'buy', target: tc.id });

            if (r.ok) {
                say('shop: tarot', tc.name);
                actions.push(`tarot:${tc.name}`);
                continue;
            }

            jw({ e: 'shopfail', what: tc.name, code: r.error?.code });
            failed.add(tc.id);
            continue;
        }

        // 4) booster packs (Celestial handled earlier): 'use' = buy+open (costs money)
        const pk = items.find((i) => kind(i) === 'booster' && has(i, 'use') && wantPack(i, o) && money - (i.cost ?? 4) >= keepFloor);

        if (pk) {
            if (await openBooster(o, pk, needFam, actions)) {
                continue;
            }

            failed.add(pk.id);
            continue;
        }

        /* 5) reroll while rich (families already maxed / spare money path);
           hunt rerolls above already consumed their bounded share */
        const rr = (o.controls || []).find((c) => c.enabled && /reroll/i.test(c.kind));
        const pB = actions.filter((a) => a.startsWith('planet')).length;
        const rrTries = actions.filter((a) => a === 'reroll').length;

        if (rr && pB < 3 && rrTries < 2 && money >= (pol.rerollMin ?? 16)) {
            const r = await act({ epoch: o.epoch, action: 'activate', target: rr.id });

            if (r.ok) {
                actions.push('reroll');
                continue;
            }
        }

        /* cat: joker class pass-through for skipped-offer audits; c: price so voucher
           skip forensics can separate "poverty" from "ordering drained the money" */
        jw({
            e: 'shopdump',
            money,
            items: (o.shop || []).map((i) => ({
                k: i.kind, n: i.name, c: i.cost, cat: i.kind === 'Joker' ? classifyJoker(i).cat : undefined, a: i.actions,
                /* e: effect text — vouchers are bought on build-specific assumptions the
                   name alone can't verify (Telescope 33x bought but focal-planet inclusion
                   stayed 22/46 packs); log the game's OWN wording at offer time */
                ef: Array.isArray(i.effect) ? i.effect.join(' ') : i.effect || undefined,
            })),
        });
        break;
    }

    jw({ e: 'shopdone', money, actions });

    return { actions, obs: await observe() };
}

/**
 * Return true when a booster pack is worth opening given money and ante.
 *
 * @param {object} item - booster offer
 * @param {object} obs - current observation
 * @returns {boolean} true when worth opening
 */
function wantPack(item, obs) {
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

/* run-scoped fruitless planet-hunt reroll counter (resetShopRun clears) */
let huntBurn = 0;

export { handleShop, resetShopRun };
