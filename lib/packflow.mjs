/* packflow.mjs — the booster-PACK flow (IO side of packs): open, score offers via
   pack.mjs valuation, take picks (with gamefam level attribution), close/skip.
   Owns per-run pack state (offer-dump dedup keys + the mirrored hands snapshot the
   shop phase fails to carry). */

import { act } from './link.mjs';
import { jw, say } from './knowledge.mjs';
import { chooseStrategy } from './strategy.mjs';
import { scorePackOffer } from './pack.mjs';
import { PLANET_GRIND, FAM_BY_PLANET } from './planets.mjs';
import { JUNK_JOKER } from './jokers.mjs';
import { dominantSuit } from './tarot.mjs';
import { lvSnap, noteLv, flushLv } from './planetneed.mjs';

/**
 * Extract the offer list from a pack-open result (array, nested offers, or object form).
 *
 * @param {object} po - pack-open result observation
 * @returns {object[]} offer items (empty when none)
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
/* Shop-phase observations often carry hands:[] (9699: TWO Celestial packs burned with
   every planet scoring the skip bar because played counters read 0). The driver mirrors
   its hands snapshot here so pack picking always sees the run's real played counts. */
let metaHands = [];

/**
 * Mirror the driver's latest hands snapshot for pack scoring fallback.
 *
 * @param {object[]} h - hands rows from a blind-phase observation
 * @returns {void}
 */
function setPackMetaHands(h) {
    if (Array.isArray(h) && h.length) {
        metaHands = h;
    }
}

/** Forget per-run pack state (offer-dump dedup keys restart at the same small ids). */
function resetPackRun() {
    packSeen.clear();
    metaHands = [];
}

/**
 * Return the best pack offer worth taking, or null when none clear the junk bar.
 *
 * @param {object} po - pack-open result
 * @param {(string | null)} needFam - hand family the run grinds
 * @param {object} ctxObs - live observation for suit/level context
 * @param {boolean} [sunk] - pack already paid: take any planet rather than bin it
 * @returns {(object | null)} best offer when found
 */
function pickPack(po, needFam, ctxObs, sunk = false) {
    const offers = packOffers(po).filter((o) => o && typeof o === 'object' && (o.actions || []).includes('use'));
    /* audit: which planets each pack ACTUALLY held (both shop-path and voucher-path
       funnel through here). Offer ids are per-area SLOT ids: they are reused across
       shops AND runs, so the dedup key carries ante+money too (9808 lost two of three
       Celestial dumps to same-run slot reuse; identical ante+money+ids re-picks of
       the same open pack still dedup) */
    const dk = `${ctxObs?.run?.ante ?? 0}|${ctxObs?.run?.money ?? 0}|${offers.map((o) => o.id).join(',')}`;

    if (offers.length && !packSeen.has(dk)) {
        packSeen.add(dk);
        jw({ e: 'packdump', px: [...new Set(offers.flatMap((o) => Object.keys(o)))].join(','), items: offers.map((o) => ({ n: o.name || o.rank || '?', k: o.kind, c: o.cost ?? '', e: (o.enhancements || []).join('/'), s: o.seal || (o.values && o.values.seal) || '', x: Object.keys(o).filter((k2) => /edition|seal|copy|sticker/i.test(k2)).map((k2) => `${k2}=${JSON.stringify(o[k2])}`).join(';') })) });
    }

    const levels = {};
    const played = {};

    for (const h of (ctxObs?.hands?.length ? ctxObs.hands : metaHands)) {
        if (h && h.name) {
            levels[h.name] = h.level ?? 1;
            played[h.name] = h.played ?? h.times_played ?? 0;
        }
    }

    /* ANTE-5 CONCENTRATION (a7 CHIP_GAP 1793161506: lvlAct 10 smeared over TP6/Pair4/
       Flush2/Trips2, ~14k total vs 70k target; a5 twin 1793161507 same smear): side-
       grinder filler levels stop compounding the one family that can clear 22k+. Zero
       the non-lead grind families' plays so their off-target tiers collapse under the
       take bar; only the lead family's planet stays takeable as focal backup */
    const antePk = Number(ctxObs?.run?.ante) || 0;

    if (antePk >= 5) {
        let lead = null;
        let leadP = -1;

        for (const [f, p] of Object.entries(played)) {
            if (PLANET_GRIND.has(f) && (p ?? 0) > leadP) {
                leadP = p;
                lead = f;
            }
        }

        for (const f of Object.keys(played)) {
            if (f !== lead) {
                delete played[f];
            }
        }
    }

    const ctx = {
        fam: needFam, needFam, ante: antePk, suit: dominantSuit(ctxObs), levels, played,
    };

    /* PICKDIAG (availability audit 10-30: 9/22 takes bought a NON-focal planet while
       the focal planet WAS on the shelf/opened pack - nf says the shop hunted X, the
       pick took Y): log the scorer's own ranked inputs at decision time (same ctx as
       the real loop below) to split [needFam mutated late] vs [scorer ranks focal
       below a filler under the tier bands]. */
    if (offers.length && offers.some((o) => String(o.kind ?? '').toLowerCase() === 'planet')) {
        const ranked = offers.map((o) => ({ n: o.name ?? '?', s: String(o.kind ?? '').toLowerCase() === 'planet' ? scorePackOffer(o, ctx) : 0 })).sort((a, b) => b.s - a.s);

        jw({ e: 'pickdiag', needFam, ante: antePk, sunk: sunk ? 1 : 0, offers: ranked.map((r) => `${r.n}:${r.s}`).join(',') });
    }

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

    /* SUNK-COST TAKE (7528: three paid Celestials at $4/$4/$6, FOCAL-FIRST zeroed every
       filler planet while TP starved at L1 -> pack binned, $14 gone, lvlAct 0): the money
       is spent either way and a level is permanent - bin is strictly worse than any
       planet. Only paid-shop opens pass sunk; free voucher packs keep the skip. */
    if (!best && sunk) {
        const cands = offers.filter((o) => String(o.kind ?? '').toLowerCase() === 'planet');

        const scored = cands.map((o) => {
            const f = Object.entries(FAM_BY_PLANET).find(([p]) => p === (o.name || ''))?.[1] ?? null;
            let s = 1;

            if (PLANET_GRIND.has(f)) {
                s = (played[f] ?? 0) > 0 ? 2.5 : 2;
            }

            if (f === needFam) {
                s = 3;
            }

            return { o, s };
        }).sort((a, b) => b.s - a.s);

        best = scored[0]?.o ?? null;
    }

    return best;
}

/**
 * Handle a standalone booster pack phase (booster already open at top level).
 *
 * @param {object} obs - current observation
 * @returns {Promise<boolean>} true once the pack was played or skipped
 */
async function handlePackOpen(obs) {
    flushLv(obs.hands);
    const strat = chooseStrategy(obs);
    const best = pickPack(obs, strat.fam, obs);

    if (best) {
        const _lb = lvSnap(obs);
        const r = await act({ epoch: obs.epoch, action: 'use', target: best.id });

        if (r.ok) {
            say('pack: take', best.name || best.rank || '?');
            noteLv(best.name || best.rank || '?', 'pack', _lb, r.result && r.result.hands);

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
        const best = pickPack(po, needFam, o, true);

        if (!best) {
            break;
        }

        const _lb = lvSnap(po);
        const rp = await act({ epoch: po.epoch, action: 'use', target: best.id });

        if (!rp.ok) {
            jw({ e: 'packfail', code: rp.error?.code });
            break;
        }

        actions.push(`take:${best.name || best.rank || '?'}`);
        noteLv(best.name || best.rank || '?', 'pack', _lb, rp.result && rp.result.hands);
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

export { packOffers, setPackMetaHands, resetPackRun, pickPack, handlePackOpen, openBooster };
