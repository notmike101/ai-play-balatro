// shop.mjs — shop purchasing, booster packs, planet targeting.
import { observe, act } from './link.mjs';
import { policy, say, jw, jokerTier, buildFamilies, JUNK_JOKER } from './knowledge.mjs';
import { chooseStrategy, classifyJoker, scorePackOffer, dominantSuit, PLANET_GRIND } from './strategy.mjs';

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

/* canonical Balatro planet->family (keep in sync with strategy.mjs PLANET_KEY/PLANET_NAME) */
const FAM_BY_PLANET = { Pluto: 'High Card', Mercury: 'Pair', Uranus: 'Two Pair', Venus: 'Three of a Kind', Saturn: 'Straight', Jupiter: 'Flush', Earth: 'Full House', Mars: 'Four of a Kind', Neptune: 'Straight Flush' };
const PLANET_NAMES = new Set(Object.keys(FAM_BY_PLANET));
const FAM_TEXT = [['straight flush', 'Straight Flush'], ['four of a kind', 'Four of a Kind'], ['full house', 'Full House'], ['three of a kind', 'Three of a Kind'], ['two pair', 'Two Pair'], ['high card', 'High Card'], ['flush', 'Flush'], ['straight', 'Straight'], ['pair', 'Pair']];

/**
 * Return the hand family named in free text, or null.
 *
 * @param {string} t - lowercased effect/name text
 * @returns {(string | null)} family name when found
 */
function famInText(t) {
    const s = String(t).toLowerCase();

    for (const [k, f] of FAM_TEXT) {
        if (s.includes(k)) {
            return f;
        }
    }

    return null;
}

/**
 * Return the hand family a planet item levels up, or null.
 *
 * @param {object} item - shop or pack item
 * @returns {(string | null)} family name when found
 */
function planetFam(item) {
    const t = `${(item.effect || []).join(' ')} ${item.name || ''}`;
    const byText = famInText(t);

    if (byText) {
        return byText;
    }

    const byName = Object.entries(FAM_BY_PLANET).find(([p]) => t.toLowerCase().includes(p.toLowerCase()));

    return byName ? byName[1] : null;
}

/**
 * Return truthy when an item is a buyable planet card.
 *
 * @param {object} i - shop item
 * @returns {(boolean | string | null)} planetFam result when buyable
 */
const isPl = (i) => (has(i, 'buy_and_use') || has(i, 'buy')) && (kind(i) === 'planet' || PLANET_NAMES.has(i.name || '')) && planetFam(i);

/**
 * Return the hands-family row most worth leveling, or null for NO planet target.
 * With play evidence: most-played GRINDABLE family (ties -> strongest base). Before
 * evidence (max played < 2) nothing is targeted: SF/4ok/FH never close on the RED
 * profile and leveling them is a dead $4-6 (two window runs spent 5 levels there:
 * SF:3+3ok:2 with TP focal L1; Neptune/SF while TP led play).
 *
 * @param {(object[] | undefined)} handsTable - run hands table rows
 * @returns {(object | null)} row with f, lvl and played fields
 */
function nextPlanetNeed(handsTable) {
    const fams = buildFamilies();
    const rows = fams.map((f) => {
        const r = (handsTable || []).find((h) => h.name === f);

        return { f, lvl: r?.level ?? 1, played: r?.played ?? r?.times_played ?? 0 };
    });
    const usable = rows.filter((r) => r.lvl < 9 && PLANET_GRIND.has(r.f));

    if (!usable.length) {
        return null;
    }

    const maxP = Math.max(...rows.filter((r) => PLANET_GRIND.has(r.f)).map((r) => r.played));

    if (maxP >= 2) {
        /* maxed most-played fam yields null: level 9 buys nothing and an unevidenced
           fallback fam is exactly the junk-planet failure this gate removes */
        const top = rows.filter((r) => r.played === maxP && PLANET_GRIND.has(r.f) && r.lvl < 9);

        if (top.length) {
            return top.sort((a, b) => fams.indexOf(a.f) - fams.indexOf(b.f))[0];
        }
    }

    return null;
}

/**
 * Handle a standalone booster pack phase (booster already open at top level).
 *
 * @param {object} obs - current observation
 * @returns {Promise<boolean>} true once the pack was played or skipped
 */
async function handlePackOpen(obs) {
    const strat = chooseStrategy(obs);
    const best = pickPack(obs, strat.fam, obs);

    if (best) {
        const r = await act({ epoch: obs.epoch, action: 'use', target: best.id });

        if (r.ok) {
            say('pack: take', best.name || best.rank || '?');

            return true;
        }

        jw({ e: 'packfail', what: best.name, code: r.error?.code });
    }

    const cl = (obs.controls || []).find((c) => c.enabled && /skip|close|leave|next|exit/i.test(`${c.kind} ${c.label || ''}`));

    if (cl) {
        await act({ epoch: obs.epoch, action: 'activate', target: cl.id });
    } else {
        jw({ e: 'packstuck', controls: (obs.controls || []).map((c) => c.kind) });
    }

    return true;
}

/**
 * Buy and open a booster pack, take its scored picks, then close it.
 *
 * @param {object} o - shop observation
 * @param {object} pk - booster item
 * @param {string | null} needFam - planet family the strategy wants
 * @param {string[]} actions - action log sink
 * @returns {Promise<boolean>} true when the pack was bought and opened
 */
async function openBooster(o, pk, needFam, actions) {
    const r = await act({ epoch: o.epoch, action: 'use', target: pk.id });

    if (!r.ok) {
        jw({ e: 'shopfail', what: pk.name, code: r.error?.code });

        return false;
    }

    actions.push(`pack:${pk.name}`);
    let po = r.result;

    for (let p2 = 0; p2 < 6; p2++) {
        const best = pickPack(po, needFam, o);

        if (!best) {
            break;
        }

        const rp = await act({ epoch: po.epoch, action: 'use', target: best.id });

        if (!rp.ok) {
            jw({ e: 'packfail', code: rp.error?.code });
            break;
        }

        actions.push(`take:${best.name || best.rank || '?'}`);
        po = rp.result;

        if (!(po.pack || []).length && po.phase !== 'pack') {
            break;
        }
    }

    const cl = (po.controls || []).find((c) => c.enabled && /skip|close|leave|next|exit/i.test(c.kind + (c.label || '')));

    if (cl) {
        await act({ epoch: po.epoch, action: 'activate', target: cl.id });
    }

    return true;
}

/* supply vouchers (Planet Merchant / Telescope) already redeemed THIS RUN? Gates
   the SUPPLY-VOUCHER-HOLD floor below; resetShopRun() re-arms per run */
const supplyBought = new Set();

/**
 * Forget run-scoped purchase state (Planet Merchant) at the start of every run.
 */
function resetShopRun() {
    supplyBought.clear();
    /* pack offer ids restart at the same small integers EVERY run, so the dump
       dedup key from one run collides on the next (8615 lost its ante-1 Celestial
       packdump to a stale key and the Jupiter take has no content row) */
    packSeen.clear();
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

    while (loop++ < 16) {
        const o = await observe();

        money = o.run?.money ?? 0;
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

        /* DECISION-LOCAL commitment: one play of lead is enough to flip target when the
           volume family's planet is what is ACTUALLY in front of us. The global +2
           margin exists to stop level churn from play-count noise, but here the scarce
           asset is on the table: run 1793041151 passed a $11 shelf Uranus at 7-6 TP-vs-
           Straight lead (and rerolled it away), then TP ran to 12 plays and died L1 */
        const volNow = nextPlanetNeed(o.hands);

        if (volNow && volNow.f !== needFam && volNow.played >= ((o.hands || []).find((h) => h.name === needFam)?.played ?? 0) + 1) {
            needFam = volNow.f;
        }

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
                /* FIELD-CENSUS: schema union + one raw Joker item sample - answers the
                   edition/negative observability question (can scoreJ bid on Foil /
                   Polychrome / Negative if the bridge ever exposes them) from the next
                   deep shop onward instead of a dedicated probe run */
                kx: [...new Set(items.flatMap((i) => Object.keys(i)))].join(','),
                rs: JSON.stringify(items.find((i) => i.kind === 'Joker') || {}).slice(0, 400),
                items: items.map((i) => ({
                    k: i.kind, n: i.name, c: i.cost, cat: i.kind === 'Joker' ? classifyJoker(i).cat : undefined, a: i.actions,
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
        const focalStarved = anteN >= 3 && volNow !== null && (volNow.played ?? 0) >= 5 && (volNow.lvl ?? 1) <= 1;

        const pl = items.find((i) => isPl(i) && needFam && planetFam(i) === needFam);

        if (pl) {
            const r = await act({ epoch: o.epoch, action: has(pl, 'buy_and_use') ? 'buy_and_use' : 'buy', target: pl.id });

            if (r.ok) {
                say('shop: planet', pl.name);
                actions.push(`planet:${pl.name}`);
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
        const sec = grank.length > 1 && grank[0].p - grank[1].p <= 2 && grank[1].p >= 4 && grank[1].n !== needFam ? grank[1].n : null;
        const pl2 = sec ? items.find((i) => isPl(i) && planetFam(i) === sec && !actions.includes(`planet:${i.name}`)) : null;

        if (pl2) {
            const r2 = await act({ epoch: o.epoch, action: has(pl2, 'buy_and_use') ? 'buy_and_use' : 'buy', target: pl2.id });

            if (r2.ok) {
                say('shop: planet(2nd-grinder)', pl2.name);
                actions.push(`planet:${pl2.name}`);
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

        const scored = items
            .filter((i) => kind(i) === 'joker' && !JUNK_JOKER.test(i.name || '') && has(i, 'buy'))
            .map((i) => {
                const { cat, famHint } = classifyJoker(i);

                return { i, s: (2 + (famHint && famHint === strat.fam ? 2 : 0) + (catBonus[cat] || 0) + (cat === 'xmult' ? mw : 0) + tierOf(i.name) * 0.3) * specF(i) };
            })
            /* engine-starved (3998: 20p Pair L3, 11 buyable non-junk shop items across
               a2-a4, s>=3 skipped every Green/Raised-Fist-class filler, died on the
               Needle with ONE joker): an empty slot is strictly worse than verified
               mid-tier — JUNK_JOKER still blocks the true junk, and the sell-weakest
               swap path below keeps slots reclaimable */
            .filter((x) => ownedJ < jLimit ? x.s >= fillMin : x.s >= weakS + 0.8)
            .sort((a, b) => b.s - a.s);
        /* ELITE-BUY OVERRIDE (30575-era jkpass capture: Ramen Joker, score 5.8 xmult —
           best joker seen all era — skipped at a3 because money 13 - cost 6 < the $8
           keepFloor; run died at that same ante needing ~2k/hand more): keepFloor
           protects the reroll/pack lottery, but a 5+ joker beats any lottery ticket.
           Spend down to the joker itself; sell-swap still guards slots downstream */
        /* MID-BAND EXEMPTION v2 (jkpass captures: Lusty 3.1 $11/$5 and Ride-the-Bus
           3.4 $10/$8 skipped by the $8 keepFloor at a3 with the saved money going to
           EMPTY rerolls; a guaranteed 3+ joker beats the reroll lottery the floor
           funds): s>=3 buys only need $4 left — unless a supply voucher is pending,
           where the hold floor stays king (PM/Telescope outvalue any 3.x filler; the
           multi-shop hold conversion 3058154 must not regress); s>=5 stays floorless */
        let jkFloor = keepFloor;

        if (scored.length && scored[0].s >= 5) {
            jkFloor = 0;
        } else if (scored.length && scored[0].s >= 3 && !sv) {
            jkFloor = Math.min(4, keepFloor);
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
        if (rrh && pB0 === 0 && needFam !== null && !actions.some((a) => a.startsWith('pack:') && /celestial/i.test(a)) && rrT0 < 2 && (o.run?.ante ?? 1) >= 2 && money - 5 >= (focalStarved ? 2 : Math.max(keepFloor, 6))) {
            const rh = await act({ epoch: o.epoch, action: 'activate', target: rrh.id });

            if (rh.ok) {
                say('shop: hunt-planet reroll');
                actions.push('reroll');
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
        const tc = slotFree > 0 && items.find((i) => kind(i) === 'tarot' && has(i, 'buy') && (earlyOk || /judgement/i.test(`${i.name || ''}`)) && !/fool|temperance/i.test(`${i.name || ''}`) && money - (i.cost ?? 3) >= tcFloor);

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

/**
 * Return the offers list from a pack-open result in either shape.
 *
 * @param {object} po - pack-open result
 * @returns {object[]} offer items
 */
function packOffers(po) {
    const p = po.pack;

    if (Array.isArray(p)) {
        return (p.length && Array.isArray(p[0]?.offers)) ? p[0].offers : p;
    }

    if (p && Array.isArray(p.offers)) {
        return p.offers;
    }

    return [];
}

const packSeen = new Set();

/**
 * Return the best pack offer worth taking, or null when none clear the junk bar.
 *
 * @param {object} po - pack-open result
 * @param {(string | null)} needFam - hand family the run grinds
 * @param {object} ctxObs - live observation for suit/level context
 * @returns {(object | null)} best offer when found
 */
function pickPack(po, needFam, ctxObs) {
    const offers = packOffers(po).filter((o) => o && typeof o === 'object' && (o.actions || []).includes('use'));
    /* audit: which planets each pack ACTUALLY held (both shop-path and voucher-path
       funnel through here). Offer ids are per-area SLOT ids: they are reused across
       shops AND runs, so the dedup key carries ante+money too (9808 lost two of three
       Celestial dumps to same-run slot reuse; identical ante+money+ids re-picks of
       the same open pack still dedup) */
    const dk = `${ctxObs?.run?.ante ?? 0}|${ctxObs?.run?.money ?? 0}|${offers.map((o) => o.id).join(',')}`;

    if (offers.length && !packSeen.has(dk)) {
        packSeen.add(dk);
        jw({ e: 'packdump', px: [...new Set(offers.flatMap((o) => Object.keys(o)))].join(','), items: offers.map((o) => ({ n: o.name || o.rank || '?', k: o.kind, e: (o.enhancements || []).join('/'), s: o.seal || (o.values && o.values.seal) || '', x: Object.keys(o).filter((k2) => /edition|seal|copy|sticker/i.test(k2)).map((k2) => `${k2}=${JSON.stringify(o[k2])}`).join(';') })) });
    }

    const levels = {};
    const played = {};

    for (const h of (ctxObs && ctxObs.hands) || []) {
        if (h && h.name) {
            levels[h.name] = h.level ?? 1;
            played[h.name] = h.played ?? h.times_played ?? 0;
        }
    }

    const ctx = {
        fam: needFam, needFam, suit: dominantSuit(ctxObs), levels, played,
    };

    let best = null;
    // take strictly above 3 (bs starts at 3; score 3 = skip)
    let bs = 3;

    for (const o of offers) {
        /* Buffoon packs must not smuggle tier-0 junk past the shop joker filter
           (run 1793029876 took Wily Joker from a Buffoon, half the a2-boss engine) */
        if (String(o.kind ?? '').toLowerCase() === 'joker' && JUNK_JOKER.test(o.name || '')) {
            continue;
        }

        const s = scorePackOffer(o, ctx);

        if (s > bs) {
            bs = s;
            best = o;
        }
    }

    return best;
}

export { FAM_BY_PLANET, PLANET_NAMES, planetFam, nextPlanetNeed, handlePackOpen, handleShop, resetShopRun };
