/* Act-layer helpers: joker-lineup sync, telemetry probe, highlight play/discard, targeted tarot use. */
import { act, observe } from './link.mjs';
import { jokerFactor, jokerSig, jw } from './knowledge.mjs';

let jokSig = null;
let deckProbed = false;

/**
 * Clear joker residuals whenever the joker multiset changes (shop buy/sell, theft, new lineup).
 * A factor learned under lineup A overpredicts under lineup B - the lethal miss class.
 *
 * @param {object} obs - current observation
 */
export function syncJokerSig(obs) {
    const sig = (obs.jokers || []).map((j) => j.name).sort().join('+');

    if (sig !== jokSig) {
        jokSig = sig;

        for (const k of Object.keys(jokerFactor)) {
            delete jokerFactor[k];
            delete jokerSig[k];
        }
    }
}

/**
 * One-shot telemetry probe (while a Blue Joker is owned; retries until a non-empty
 * snapshot): dumps area kinds/counts PLUS a sanitized key/count scan of the whole
 * observation, so a top-level deck/draw field can't hide from the "unmodelable" claim.
 *
 * @param {object} obs - current observation
 * @returns {(string | null)} probe summary or null
 */
export function deckProbe(obs) {
    if (deckProbed || !(obs.jokers || []).some((j) => j.name === 'Blue Joker')) {
        return null;
    }

    const areas = (obs.areas || []).map((a) => `${a.kind}:${a.limit ?? '-'}:${(a.cards || []).length}:${a.count ?? '-'}`).join(',');
    const keys = Object.entries(obs).map(([k, v]) => {
        const shape = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : typeof v); /* eslint-disable-line no-nested-ternary */

        return `${k}(${shape})`;
    }).join(',');

    if (!areas && Object.keys(obs).length === 0) {
        return null;
    }

    deckProbed = true;

    return `areas=[${areas}] obs_keys=[${keys}] run_keys=[${Object.keys(obs.run || {}).join(',')}] deck=${JSON.stringify(obs.deck ?? null).slice(0, 420)} run_deck=${JSON.stringify(obs.run?.deck ?? null).slice(0, 160)}`;
}

/** Probe once per RUN; call from the new-run path. */
export function resetProbe() {
    deckProbed = false;
}

/**
 * Highlight cards, activate the matching control.
 *
 * @param {object} obs - current observation snapshot
 * @param {object[]} cards - cards to highlight
 * @param {string} kind - control kind to activate once cards are highlighted
 * @returns {Promise<object>} act result envelope
 */
export async function execHighlight(obs, cards, kind) {
    let verb = null;

    if (kind === 'play_cards_from_highlighted') {
        verb = 'play';
    } else if (kind === 'discard_cards_from_highlighted') {
        verb = 'discard';
    }

    const ids = cards.map((c) => c.id);

    /* CERULEAN BELL pins one card always-selected: a play set that omits it can be
       rejected by the game, and the pinned card rides along physically no matter what —
       fold every selected card into PLAY sets (never discards: pinned cards must stay) */
    if (kind === 'play_cards_from_highlighted') {
        for (const c of obs.hand || []) {
            if (c.selected && !ids.includes(c.id)) {
                ids.push(c.id);
            }
        }
    }

    const r = await act({ epoch: obs.epoch, action: 'select', cards: ids });

    if (!r.ok) {
        /* select path dead (focus-pause, tab quirk) while the adapter's DIRECT
           play/discard verb still works — proven on the a8 Bell win (10-29):
           play{cards} executed when every select/highlight act returned
           action_unavailable */
        if (verb) {
            jw({ e: 'directverb', verb, why: r.error?.code, ids });

            return await act({ epoch: obs.epoch, action: verb, cards: ids });
        }

        return r;
    }

    let o = r.result;
    let ctl = (o.controls || []).find((c) => c.enabled && c.kind === kind);

    if (!ctl) {
        o = await observe();
        ctl = (o.controls || []).find((c) => c.enabled && c.kind === kind);
    }

    if (!ctl) {
        if (verb) {
            jw({ e: 'directverb', verb, why: 'no_ctl', ids });

            return await act({ epoch: o.epoch, action: verb, cards: ids });
        }

        return { ok: false, error: { code: 'no_highlight_ctl', message: kind } };
    }

    return await act({ epoch: o.epoch, action: 'activate', target: ctl.id });
}

/**
 * Select the plan's cards, then use the tarot if its use action re-enabled; return latest obs.
 *
 * @param {object} obs - current hand-phase observation
 * @param {object} tp - {target, cards, why} plan from planTargeted
 * @param {object} suitTally - live suit-conversion tally (mutated on suit-> plans)
 * @returns {Promise<object>} observation after the attempt
 */
export async function useTargeted(obs, tp, suitTally) {
    const targets = tp.jid ? [tp.jid] : tp.cards.map((c) => c.id);
    const rs = await act({ epoch: obs.epoch, action: 'select', cards: targets });

    if (!rs.ok) {
        jw({ e: 'tarottarget', why: tp.why, ok: false, code: 'select-fail', err: rs.error?.code });

        return obs;
    }

    const ci = (rs.result.consumables || []).find((x) => x.id === tp.target);

    if (!(ci && (ci.actions || []).includes('use'))) {
        jw({ e: 'tarottarget', why: tp.why, ok: false, code: 'use-not-enabled', acts: (ci && ci.actions) || [] });

        return rs.result;
    }

    const ru = await act({ epoch: rs.result.epoch, action: 'use', target: tp.target });

    jw({ e: 'tarottarget', why: tp.why, cards: tp.jid ? [`jk:${tp.jid}`] : tp.cards.map((c) => `${c.rank}-${String(c.suit || '?')[0]}`), ok: ru.ok, code: ru.error?.code });

    if (ru.ok && tp.why.startsWith('suit->')) {
        suitTally[tp.why.slice(5)] = (suitTally[tp.why.slice(5)] || 0) + tp.cards.length;
    }

    return ru.ok ? ru.result : rs.result;
}
