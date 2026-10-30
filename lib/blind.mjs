/* Blind-select phase: family strategy choice, joker reorder, consumable use, blind activation. */
import { act, observe } from './link.mjs';
import { jw, say } from './knowledge.mjs';
import { chooseStrategy, famBiasMap, planConsumables, reorderNeeds } from './strategy.mjs';
import { jokerOrder } from './jokers.mjs';

let strat = null;
let bias = {};
let lastStratFam = null;

/**
 * Live family bias map for the hand-phase engine.
 *
 * @returns {object} bias weights
 */
function currentBias() {
    return bias;
}

/**
 * Forget strategy state (call on new run / run end).
 */
function resetStrategy() {
    strat = null;
    bias = {};
    lastStratFam = null;
}

/**
 * Run the blind-select phase: pick the grind family, reorder jokers, spend
 * consumables, then activate the blind.
 *
 * @param {object} obs0 - blind_select observation
 * @param {object} runStats - per-run accumulator (jmax updated)
 * @returns {Promise<{obs: object, cont: boolean}>} refreshed obs; cont=true means the
 *   blind was activated and the loop should re-observe
 */
async function handleBlindSelect(obs0, runStats) {
    let obs = obs0;

    strat = chooseStrategy(obs);
    bias = famBiasMap(strat, obs);

    if (strat.fam !== lastStratFam) {
        lastStratFam = strat.fam;
        say('strategy:', strat.fam, strat.why);
        jw({ e: 'strategy', fam: strat.fam, why: strat.why, in: (obs.hands || []).map((h) => [h.name, h.level ?? 1, h.played ?? 0]), jk: (obs.jokers || []).map((j) => j.name), pl: (obs.consumables || []).filter((c) => String(c.kind).toLowerCase() === 'planet').map((c) => c.name) });
    }

    const ja = (obs.areas || []).find((a) => a.kind === 'jokers');
    const order = jokerOrder(obs.jokers);

    if (ja?.reorder && (obs.jokers || []).length > 1 && reorderNeeds(obs.jokers, order)) {
        const rr = await act({ epoch: obs.epoch, action: 'reorder', target: ja.id, cards: order });

        jw({ e: 'reorder', ok: rr.ok, code: rr.error?.code, order });
        obs = rr.ok ? rr.result : obs;
    }

    const cLimit = (obs.areas || []).find((a) => a.kind === 'consumeables')?.limit ?? 2;

    for (const plan of planConsumables(obs, strat, {
        phase: 'blind_select', money: obs.run?.money, slotFreeNumber: cLimit,
    })) {
        const o2 = await observe();
        const item = (o2.consumables || []).find((c) => c.id === plan.target);

        if (item && (item.actions || []).includes('use')) {
            const ru = await act({ epoch: o2.epoch, action: 'use', target: item.id });

            jw({ e: 'consuse', why: plan.why, name: item.name, ok: ru.ok, code: ru.error?.code });
            obs = ru.ok ? ru.result : await observe();
        }
    }

    const sel = (obs.controls || []).find((c) => c.enabled && c.kind === 'select_blind');
    const boss = (obs.run?.blinds || []).find((b) => b.slot === 'Boss' && b.state === 'Select');

    /* ctrl: Director's Cut is bought 29x and NEVER used - the boss-reroll affordance
       at blind select is unprobed; log every control kind (and enabled bit) plus the
       run-object key union once per blind to find where redeemed vouchers surface */
    /* cl + tp: does skip_blind carry a LABEL previewing the offered tag (whitelist-skip
       v2 needs it), and where do held tags live as actables (areas/consumables 'use')?
       Tag census 10-30: redskip runs DID accumulate tags (26/28 rids, full pool) — the
       10-29 "grants no tag" retirement was wrong; whether tags auto-fire is UNPROVEN
       (Investment 0/2, D6 0/2 hit) — driver never had tags before, so no corpus proof */
    jw({ e: 'blind', ante: obs.run?.ante, m: obs.run?.money, name: obs.run?.blind?.name || (obs.run?.blinds || []).map((b) => `${b.name}:${b.state}`).join(','), target: obs.run?.blind?.target, effect: obs.run?.blind?.effect, jokers: ((obs.jokers || []).map((j) => j.name || j.key)), cons: ((obs.consumables || []).map((c) => `${c.name}[${(c.actions || []).join('/')}]`)), boss: boss && { name: boss.name, effect: boss.effect, target: boss.target }, ctrl: (obs.controls || []).map((c) => `${c.kind}${c.enabled ? '' : ':off'}`), rk: Object.keys(obs.run || {}).join(','), tv: JSON.stringify(obs.run?.tags ?? null).slice(0, 200), vv: JSON.stringify(obs.run?.vouchers ?? null).slice(0, 240), jx: JSON.stringify((obs.jokers || []).map((j) => [j.name, (Array.isArray(j.effect) ? j.effect.join(' ') : j.effect ?? '').slice(0, 110)])).slice(0, 620), cl: (obs.controls || []).map((c) => `${c.kind}=${c.label ?? ''}`).join(';').slice(0, 300), tp: JSON.stringify((obs.areas || []).concat(obs.consumables || []).filter((x) => /tag/i.test(String(x.kind ?? '') + String(x.key ?? '') + String(x.name ?? '')))).slice(0, 200) });
    runStats.jmax = Math.max(runStats.jmax, (obs.jokers || []).length);

    /* SKIP v1 (10-30): the 10-29 retirement rested on "grants no tag" which the tv
       census refuted (26/28 redskip rids held real tags; effect texts verbatim:
       D6 "$0 rerolls next shop", Coupon "packs free", Investment "+$25 after boss",
       Uncommon/Rare/Negative "free shop Joker"). Cost is small-blind payout ($0 on
       Red) + one shop; chosen band = Small only, ante<=3: payout forfeited is
       smallest there and the tag has 5+ antes of shops to compound in. Big/boss
       stay OFF (boss skip is disabled by the game anyway). If tagprobe rows show
       tags never auto-fire and no use affordance exists, REVERT (pure -$payout).
   SKIP-v2 (10-30, pre-registered metric fired): a1 deaths 7/22 = 32% vs 13%
   baseline (binom p=0.018); 5/7 died AT the a1 boss with <=1 joker bought,
   2/7 at big by 2 and 98 chips — skipping a1 forfeits the ONLY shop before
   big, i.e. the $4 seed joker that carries a1. a2-3 skips keep the tag reward
   with the board already seeded. Voucher money-floor stays a queued candidate
   (2 of those losses drained $10->$0 on Magic Trick in the post-big shop). */
    const smallSel = (obs.run?.blinds || []).some((b) => /small/i.test(String(b.name ?? b.slot ?? '')) && b.state === 'Select');
    const skip = (obs.controls || []).find((c) => c.enabled && c.kind === 'skip_blind');

    if (sel && skip && smallSel && (obs.run?.ante ?? 9) >= 2 && (obs.run?.ante ?? 9) <= 3) {
        const r = await act({ epoch: obs.epoch, action: 'activate', target: skip.id });

        jw({ e: 'bskip', ante: obs.run?.ante, m: obs.run?.money, ok: r.ok, code: r.error?.code, tv: JSON.stringify(obs.run?.tags ?? null).slice(0, 120) });
        if (r.ok) {
            return { obs, cont: true };
        }
    }

    if (sel) {
        const r = await act({ epoch: obs.epoch, action: 'activate', target: sel.id });

        if (!r.ok) {
            say('select fail', r.error?.code);
        }

        return { obs, cont: true };
    }

    return { obs, cont: false };
}

export { currentBias, handleBlindSelect, resetStrategy };
