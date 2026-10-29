/* Blind-select phase: family strategy choice, joker reorder, consumable use, blind activation. */
import { act, observe } from './link.mjs';
import { jw, say } from './knowledge.mjs';
import { chooseStrategy, famBiasMap, jokerOrder, planConsumables, reorderNeeds } from './strategy.mjs';

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
    jw({ e: 'blind', ante: obs.run?.ante, m: obs.run?.money, name: obs.run?.blind?.name || (obs.run?.blinds || []).map((b) => `${b.name}:${b.state}`).join(','), target: obs.run?.blind?.target, effect: obs.run?.blind?.effect, jokers: ((obs.jokers || []).map((j) => j.name || j.key)), cons: ((obs.consumables || []).map((c) => `${c.name}[${(c.actions || []).join('/')}]`)), boss: boss && { name: boss.name, effect: boss.effect, target: boss.target }, ctrl: (obs.controls || []).map((c) => `${c.kind}${c.enabled ? '' : ':off'}`), rk: Object.keys(obs.run || {}).join(','), tv: JSON.stringify(obs.run?.tags ?? null).slice(0, 200), vv: JSON.stringify(obs.run?.vouchers ?? null).slice(0, 240) });
    runStats.jmax = Math.max(runStats.jmax, (obs.jokers || []).length);

    /* SKIP ECONOMY RETIRED for Red (cohort census 10-29, n=16 true-red runs,
       avgA ~2.0 vs white 3.10, deaths dominated by ante-1): skip pays $0 here
       (redskip `m` rows: money unchanged 4->4) and grants no tag, but it ALSO
       eats the small-blind shop - the only pre-big-blind shop where a $4
       starter joker can buy the a1-big margin. Playing Red's $0 small blind
       is strictly better: same money, plus one shop. Big-blind skip stays
       OFF (real reward $4-$5); boss skip is disabled by the game anyway. */
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
