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
        const minTier = Math.min(9, ...(o.jokers || []).map((j) => tierOf(j.name)));
        const strat = chooseStrategy(o);
        const stratRow = (o.hands || []).find((h) => h.name === strat.fam);
        let needFam = null;

        if (strat.fam !== null) {
            const vol = nextPlanetNeed(o.hands);

            needFam = (stratRow?.level ?? 1) < 9 ? strat.fam : vol?.f ?? null;

            /* VOLUME COMMITMENT (4 clean drift deaths 0659/1709/5442/6063: levels
               chased strategy-EV family while actual plays concentrated elsewhere,
               focal family died at L1 with 12-20 plays): when the most-played
               grindable family outplays strategy's pick by 2+, levels follow plays */
            if ((stratRow?.level ?? 1) < 9 && vol && vol.f !== strat.fam && vol.played >= (stratRow?.played ?? 0) + 2) {
                needFam = vol.f;
            }
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

        /* Celestial packs are the guaranteed-ish planet pipeline (3+ choices incl.
           most-played fam with Telescope): buy+open BEFORE the single-slot reroll
           lottery — funnel showed 16 hunt rerolls buying 0 planets while the old
           pack-first ordering took 19 celestial picks */
        const cp = needFam !== null && items.find((i) => kind(i) === 'booster' && /celestial/i.test(i.name || '') && has(i, 'use') && wantPack(i, o) && money - (i.cost ?? 4) >= (ownedJ === 0 && anteN <= 2 ? 8 : keepFloor));

        if (cp) {
            say('shop: celestial pack', cp.name);

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

        /* strategy-scored joker buys (fam synergy / xmult / additive value);
           anteN/keepFloor already computed with the planets block above */

        const catBonus = { xmult: 1.5, chips: 0.8, add: 0.8, econ: 0.3 };
        const scored = items
            .filter((i) => kind(i) === 'joker' && !JUNK_JOKER.test(i.name || '') && has(i, 'buy') && (ownedJ < jLimit || tierOf(i.name) === 2))
            .map((i) => {
                const { cat, famHint } = classifyJoker(i);

                return { i, s: 2 + (famHint && famHint === strat.fam ? 2 : 0) + (catBonus[cat] || 0) + tierOf(i.name) * 0.3 };
            })
            .filter((x) => x.s >= 3)
            .sort((a, b) => b.s - a.s);
        const jk = scored.length && money - (scored[0].i.cost ?? 4) >= keepFloor ? scored[0].i : null;

        if (jk) {
            const r = await act({ epoch: o.epoch, action: 'buy', target: jk.id });

            if (r.ok) {
                say('shop: joker', jk.name);
                actions.push(`joker:${jk.name}`);
                continue;
            }

            if (ownedJ < jLimit || tierOf(jk.name) <= minTier) {
                jw({ e: 'shopfail', what: jk.name, code: r.error?.code });
                failed.add(jk.id);
                continue;
            }

            // slots full: sell the single weakest owned joker, then retry the buy once
            const weak = (o.jokers || []).filter((j) => (j.actions || []).includes('sell')).sort((a, b) => tierOf(a.name) - tierOf(b.name))[0];

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
        if (rrh && pB0 === 0 && needFam !== null && !actions.some((a) => a.startsWith('pack:') && /celestial/i.test(a)) && rrT0 < 2 && (o.run?.ante ?? 1) >= 2 && money - 5 >= Math.max(keepFloor, 6)) {
            const rh = await act({ epoch: o.epoch, action: 'activate', target: rrh.id });

            if (rh.ok) {
                say('shop: hunt-planet reroll');
                actions.push('reroll');
                continue;
            }
        }

        // 3) vouchers we like ('use' redeems)
        const vlist = pol.vouchers || ['Telescope', 'Overstock', 'Clearance Sale', 'Director\'s Cut', 'Retcon', 'Grabber', 'Seed Money', 'Crystal Ball', 'Hone', 'Warp Time'];
        const vc = items.find((i) => kind(i) === 'voucher' && (has(i, 'use') || has(i, 'buy')) && vlist.some((v) => (i.name || '').includes(v)));

        if (vc) {
            const r = await act({ epoch: o.epoch, action: has(vc, 'use') ? 'use' : 'buy', target: vc.id });

            if (r.ok) {
                say('shop: voucher', vc.name);
                actions.push(`voucher:${vc.name}`);
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
        const tc = slotFree > 0 && items.find((i) => kind(i) === 'tarot' && has(i, 'buy') && (earlyOk || /judgement/i.test(`${i.name || ''}`)) && !/fool|temperance/i.test(`${i.name || ''}`) && money - (i.cost ?? 3) >= keepFloor);

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
        const s = scorePackOffer(o, ctx);

        if (s > bs) {
            bs = s;
            best = o;
        }
    }

    return best;
}

export { FAM_BY_PLANET, PLANET_NAMES, planetFam, nextPlanetNeed, handlePackOpen, handleShop };
