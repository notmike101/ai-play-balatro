/* driver.mjs — autonomous Balatro grind: plays phases, shops, and the stake ladder on a chosen deck.
   Modules: lib/link (host stdio), lib/eval (hand eval), lib/play (prediction/discard), lib/shop, lib/settings, lib/knowledge (state/knobs).
   Monitor: out/state.json (current summary), out/log.jsonl (per-decision), out/results.jsonl (run outcomes). */
import fs from 'node:fs';
import path from 'node:path';
import { OUT, jw, setRunId, say, sleep, resF, wins, saveWins, stakeMap, saveStakeMap, STAKE_LABELS, policy, jokerFactor } from './lib/knowledge.mjs';
import { observe, act } from './lib/link.mjs';
import { allSubsetEvals, chooseDiscard, calibrate, famBase, ctxOf } from './lib/play.mjs';
import { handleShop, handlePackOpen, planetFam } from './lib/shop.mjs';
import { chooseStrategy, famBiasMap, jokerOrder, reorderNeeds, planConsumables, planTargeted, gateAllows } from './lib/strategy.mjs';
import { setGameSpeed } from './lib/settings.mjs';

// ---------- play-phase decision ----------

// per-blind score-accumulator estimate
let bank = { key: '', pred: 0 };
let strat = null;
let bias = {};
let lastStratFam = null;
const suitTally = {};
// restart-unique: seeded from clock, +1 per run
let runSeq = Math.floor(Date.now() / 1_000);
// learned joker residual belongs to the lineup that produced it; lineup change invalidates all
let jokSig = null;

/**
 * Clear joker residuals whenever the joker multiset changes (shop buy/sell, theft, new lineup).
 * A factor learned under lineup A overpredicts under lineup B - the lethal miss class.
 *
 * @param {object} obs - current observation
 */
function syncJokerSig(obs) {
    const sig = (obs.jokers || []).map((j) => j.name).sort().join('+');

    if (sig !== jokSig) {
        jokSig = sig;

        for (const k of Object.keys(jokerFactor)) {
            delete jokerFactor[k];
        }
    }
}

/**
 * Highlight cards, activate the matching control.
 *
 * @param {object} obs - current observation snapshot
 * @param {object[]} cards - cards to highlight
 * @param {string} kind - control kind to activate once cards are highlighted
 * @returns {Promise<object>} act result envelope
 */
async function execHighlight(obs, cards, kind) {
    const r = await act({ epoch: obs.epoch, action: 'select', cards: cards.map((c) => c.id) });

    if (!r.ok) {
        return r;
    }

    let o = r.result;
    let ctl = (o.controls || []).find((c) => c.enabled && c.kind === kind);

    if (!ctl) {
        o = await observe();
        ctl = (o.controls || []).find((c) => c.enabled && c.kind === kind);
    }

    if (!ctl) {
        return { ok: false, error: { code: 'no_highlight_ctl', message: kind } };
    }

    return await act({ epoch: o.epoch, action: 'activate', target: ctl.id });
}

/**
 * Select the plan's cards, then use the tarot if its use action re-enabled; return latest obs.
 *
 * @param {object} obs - current hand-phase observation
 * @param {object} tp - {target, cards, why} plan from planTargeted
 * @returns {Promise<object>} observation after the attempt
 */
async function useTargeted(obs, tp) {
    const rs = await act({ epoch: obs.epoch, action: 'select', cards: tp.cards.map((c) => c.id) });

    if (!rs.ok) {
        return obs;
    }

    const ci = (rs.result.consumables || []).find((x) => x.id === tp.target);

    if (!(ci && (ci.actions || []).includes('use'))) {
        jw({ e: 'tarottarget', why: tp.why, ok: false, code: 'use-not-enabled', acts: (ci && ci.actions) || [] });

        return rs.result;
    }

    const ru = await act({ epoch: rs.result.epoch, action: 'use', target: tp.target });

    jw({ e: 'tarottarget', why: tp.why, cards: tp.cards.map((c) => `${c.rank}-${String(c.suit || '?')[0]}`), ok: ru.ok, code: ru.error?.code });

    if (ru.ok && tp.why.startsWith('suit->')) {
        suitTally[tp.why.slice(5)] = (suitTally[tp.why.slice(5)] || 0) + tp.cards.length;
    }

    return ru.ok ? ru.result : rs.result;
}

/**
 * Choose and execute the best play or discard for the current hand.
 *
 * @param {object} obs - observation snapshot for the hand/play phase
 * @returns {Promise<object>} decision record with action, act result, and score-estimate fields
 */
async function playTurn(obs) {
    const run = obs.run;
    const hand = obs.hand || [];

    syncJokerSig(obs);

    /* current_score never updates on this build; estimate banked via our own predictions
       run.chips is this blind's real accumulated score (verified 0->40->54->98 growth, resets per blind); bank pred only as fallback */
    const truthC = run.chips ?? null;
    const rem = truthC !== null ? Math.max(0, (run.blind?.target ?? 0) - truthC) : Math.max(0, (run.blind?.target ?? 0) - bank.pred);
    const bname = run.blind?.name || '';
    // must play exactly 5 cards
    const forced5 = /Psychic/.test(bname);
    // Mouth: only ONE hand type all blind (lock it). Eye: NO REPEATING a type (ban played ones)
    const mouthOnly = bname === 'The Mouth';
    const eyeNoRep = bname === 'The Eye';

    let ev = allSubsetEvals(hand, obs.hands, bias, ctxOf(obs));

    if (forced5) {
        ev = ev.filter((o) => o.cards.length === 5);
    }

    if (eyeNoRep) {
        const f = ev.filter((o) => !(bank.eyeFams || {})[o.fam]);

        if (f.length) {
            ev = f;
        }
    }

    if (mouthOnly && bank.lockFam) {
        const f = ev.filter((o) => o.fam === bank.lockFam);

        if (f.length) {
            ev = f;
        } else if ((run.discards_left ?? 0) > 0) {
            ev = [];
        }
    }

    const handsLeft = run.hands_left ?? 1;
    const discLeft = run.discards_left ?? 0;

    if (!ev.length) {
        if (discLeft > 0) {
            const d = chooseDiscard(hand, null, bank.lockFam ?? null);

            if (d && d.length) {
                const r = await execHighlight(obs, d, 'discard_cards_from_highlighted');

                if (r.ok) {
                    return { action: 'discard', r, n: d.length };
                }
            }
        }

        /* all cards can be debuffed (bosses) yet stay legally playable for zero — never stall on filtering */
        let playable = hand.filter((c) => !c.debuffed && (c.actions || []).includes('select'));

        if (!playable.length) {
            playable = hand.filter((c) => (c.actions || []).includes('select'));
        }

        const five = playable.slice(0, 5);

        if (!five.length) {
            return { action: 'stuck' };
        }

        const r = await execHighlight(obs, five, 'play_cards_from_highlighted');

        return { action: 'play', r, fam: '?', scoring: [], pred: 0, rem };
    }

    const best = ev[0];
    const needPer = rem / Math.max(1, handsLeft);
    const needMore = discLeft > 0 && handsLeft > 1 && best.pred < needPer;

    if (needMore) {
        const d = chooseDiscard(hand, best, bank.lockFam ?? null);

        if (d && d.length) {
            const r = await execHighlight(obs, d, 'discard_cards_from_highlighted');

            if (r.ok) {
                return { action: 'discard', r, n: d.length };
            }

            say('discard fail', r.error?.code, '- playing instead');
        }
    }

    const r = await execHighlight(obs, best.cards, 'play_cards_from_highlighted');

    if (mouthOnly && r.ok && !bank.lockFam) {
        bank.lockFam = best.fam;
    }

    if (eyeNoRep && r.ok) {
        (bank.eyeFams = bank.eyeFams || {})[best.fam] = 1;
    }

    return { action: 'play', r, fam: best.fam, scoring: best.scoring, pred: best.pred, rem };
}

/**
 * Which family this hand will actually play (used to pick the matching planet BEFORE playing).
 *
 * @param {object} obs - current observation
 * @returns {(string | null)} family name or null
 */
function peekPlayFam(obs) {
    syncJokerSig(obs);

    let ev = allSubsetEvals(obs.hand || [], obs.hands, bias, ctxOf(obs));

    if (/Psychic/.test(obs.run?.blind?.name || '')) {
        ev = ev.filter((o) => o.cards.length === 5);
    }

    if (bank.lockFam && obs.run?.blind?.name === 'The Mouth') {
        const f = ev.filter((o) => o.fam === bank.lockFam);

        if (f.length) {
            ev = f;
        }
    }

    if (obs.run?.blind?.name === 'The Eye') {
        const f = ev.filter((o) => !(bank.eyeFams || {})[o.fam]);

        if (f.length) {
            ev = f;
        }
    }

    return ev.length ? ev[0].fam : null;
}

// ---------- New Run setup ----------
/**
 * Find the paired direction-cycle control for an option_cycle, falling back to itself.
 *
 * @param {object[]} all - all controls from the current observation
 * @param {object} c - the option_cycle control being rotated
 * @param {string} dir - wanted direction, 'l' or 'r'
 * @returns {object | null} matching enabled cycle control, or null
 */
function cyclePartner(all, c, dir) {
    return all.find((x) => x.enabled && x.kind === 'option_cycle' && Array.isArray(x.options)
        && x.options.length === c.options.length && x.options[0] === c.options[0] && x.direction === dir)
    || (c.direction === dir ? c : null);
}

let pendingStakeLabel = null;

/**
 * Drive the New Run overlay: cycle to the wanted deck and stake, then start the run.
 *
 * @param {object} obs - overlay-phase observation
 * @returns {Promise<boolean>} true once the run start was accepted
 */
async function handleNewRun(obs) {
    const pol = policy();

    fs.writeFileSync(path.join(OUT, 'overlay.json'), JSON.stringify(obs));
    const wantDeck = pol.deck || 'Red Deck';
    const unwon = STAKE_LABELS.find((l) => !wins.has(l)) || STAKE_LABELS[7];
    let o = obs;

    for (let round = 0; round < 40; round++) {
        const cycles = (o.controls || []).filter((c) => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options));
        // NOTE: option_cycle `index` is 1-based (index 1 == options[0]); auto-detect base from a control whose index is valid 0-based.
        const base0 = cycles.some((c) => c.index >= c.options.length);
        /**
         * Read an option label, compensating for the 1-based index reported by controls.
         *
         * @param {object} c - option_cycle control
         * @param {number} i - control-reported index
         * @returns {string} option label
         */
        // eslint-disable-next-line unicorn/consistent-function-scoping -- reads base0 detected per loop round
        const at = (c, i) => c.options[i - (base0 ? 0 : 1)];
        const deckC = cycles.find((c) => c.options.some((s) => /deck/i.test(s)));
        const stakeC = cycles.find((c) => c !== deckC && c.options.some((s) => /stake/i.test(s)));
        let c = null;
        let ti = -1;

        if (deckC && at(deckC, deckC.index) !== wantDeck) {
            c = deckC;
            ti = deckC.options.indexOf(wantDeck);
        } else if (stakeC && at(stakeC, stakeC.index) !== unwon) {
            c = stakeC;
            ti = stakeC.options.indexOf(unwon);
        }

        if (!c || ti < 0) {
            break;
        }

        const n = c.options.length;
        const cur = ((c.index + (base0 ? 0 : n - 1)) % n);
        const delta = (ti - cur + n) % n;
        const useCtl = cyclePartner(o.controls, c, delta <= n / 2 ? 'r' : 'l');

        if (!useCtl) {
            break;
        }

        const r = await act({ epoch: o.epoch, action: 'activate', target: useCtl.id });

        if (!r.ok) {
            jw({ e: 'cyclefail', code: r.error?.code });
            break;
        }

        o = r.result;
    }

    const stakeCyc = (o.controls || []).find((c) => c.kind === 'option_cycle' && Array.isArray(c.options) && c.options.some((s) => /stake/i.test(s)));
    const sBase0 = stakeCyc && stakeCyc.index >= stakeCyc.options.length;
    const stakeLbl = stakeCyc ? stakeCyc.options[stakeCyc.index - (sBase0 ? 0 : 1)] : null;
    const start = (o.controls || []).find((c) => c.enabled && /start_setup_run/.test(c.kind));

    if (!start) {
        jw({ e: 'overlaystuck', controls: (o.controls || []).map((c) => `${c.kind}:${c.label}`) });

        return false;
    }

    const r = await act({ epoch: o.epoch, action: 'activate', target: start.id });

    if (!r.ok) {
        jw({ e: 'startfail', code: r.error?.code });

        return false;
    }

    pendingStakeLabel = stakeLbl || unwon;
    say('run started, stake label =', pendingStakeLabel);

    runSeq += 1;
    setRunId(runSeq);
    jw({ e: 'runstart', stake: stakeLbl || unwon });
    strat = null;
    bias = {};
    lastStratFam = null;
    bank = { key: '', pred: 0 };

    for (const k of Object.keys(jokerFactor)) {
        delete jokerFactor[k];
    }

    for (const k of Object.keys(suitTally)) {
        delete suitTally[k];
    }

    await sleep(800);

    return true;
}

// ---------- main loop ----------
let curStake = null;
let curDeckKey = null;

/**
 * Main observe-and-act loop covering every game phase until the process exits.
 */
async function main() {
    let idle = 0;

    for (;;) {
        if (fs.existsSync(path.join(OUT, 'pause'))) {
            await sleep(3_000);
            continue;
        }

        let obs = await observe();
        const ph = obs.phase;

        fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify({ t: Date.now(), phase: ph, epoch: obs.epoch, run: obs.run && { money: obs.run.money, ante: obs.run.ante, round: obs.run.round, stake: obs.run.stake, deck: obs.run.deck?.key, score: obs.run.current_score, hands_left: obs.run.hands_left, discards_left: obs.run.discards_left, target: obs.run.blind?.target, name: obs.run.blind?.name }, jokers: (obs.jokers || []).map((j) => j.name), wins: [...wins] }, null, 1));

        if ((ph === 'hand' || ph === 'play') && obs.run) {
            curStake = obs.run.stake;
            curDeckKey = obs.run.deck?.key;

            const bkey = `${obs.run.round}:${obs.run.blind?.name || ''}`;

            if (bank.key !== bkey) {
                bank = { key: bkey, pred: 0, byFam: {}, eyeFams: {}, target: obs.run.blind?.target ?? 0 };
            }

            /* Blind still alive with bank >= target => banked predictions overshot reality (no current_score in this build);
               true score is < target, so re-anchor to zero instead of believing the phantom "already won". */
            if (bank.target > 0 && bank.pred >= bank.target) {
                jw({ e: 'resync', bank: Math.round(bank.pred), target: bank.target });
                // only bound while blind alive: real score < target; keep zero (no real score field in this build)
                bank.pred = 0;
            }

            // strategic planet: level the family THIS hand will play; other planets bank for later
            const pf = peekPlayFam(obs);
            const pc = pf && (obs.consumables || []).find((c) => String(c.kind || '').toLowerCase() === 'planet' && (c.actions || []).includes('use') && planetFam(c) === pf);

            if (pc) {
                const r = await act({ epoch: obs.epoch, action: 'use', target: pc.id });

                if (r.ok) {
                    obs = r.result;
                    jw({ e: 'planet', fam: pf });
                }
            }

            // targeted tarot on hand cards: select then use (Magician/Empress/Tower/Death/Hierophant)
            for (const tp of planTargeted(obs, suitTally)) {
                obs = await useTargeted(obs, tp);
            }

            const before = obs.run.chips ?? null;

            jw({ e: 'turn', hand: (obs.hand || []).map((c) => [c.id, c.rank, c.suit, (c.actions || []).join('/'), c.debuffed ? 'D' : '', (c.enhancements || []).concat(c.key && c.key !== 'c_base' ? [c.key] : [], c.values && c.values.type ? [`t:${c.values.type}`] : []).join('|')]), chips: obs.run.chips, epoch: obs.epoch, dl: obs.run.discards_left ?? null, hl: obs.run.hands_left ?? null, jk: (obs.jokers || []).map((j) => [j.name, j.value ?? null, j.extra ?? null, j.values ?? null]), rerolls: obs.run.rerolls_left ?? obs.run.rerolls ?? null });
            const t = await playTurn(obs);

            t.nullCards = (obs.hand || []).filter((c) => !c.rank).length;
            jw({ e: 'decide', a: t.action, fam: t.fam, pred: t.pred, rem: t.rem, n: t.n, ante: obs.run?.ante, b: obs.run?.blind?.name, tgt: obs.run?.blind?.target ?? null, rchips: t.r && t.r.ok ? t.r.result.run?.chips : null, err: t.r && !t.r.ok ? t.r.error?.code : null, ef: Object.keys(bank.eyeFams || {}).join('/'), lk: bank.lockFam || '' });

            if (t.r && !t.r.ok) {
                say('turn err', t.r.error?.code);
                await sleep(1_500);
                const again = await observe();

                if ((again.phase || '') !== 'hand') {
                    continue;
                }
            } else if (t.r && t.action === 'play') {
                const afterC = t.r.result.run?.chips ?? null;
                // real per-hand delta only when both ends observed the same live blind (after < before => blind transitioned)
                const d = before !== null && afterC !== null && afterC >= before ? afterC - before : null;
                /* no chips field: fall back to prediction estimate. Exception: Cerulean-Bell all-face-down hands score
                   nothing and the observed null-rank hand proves the play never scored — don't bank phantoms. */
                const phantom = d === 0 && t.nullCards > 0;
                const credit = d !== null ? d : t.pred;

                // face-down (Fish/Mark) hands score under guessed fams — never fold their deltas into jokerFactor
                if (d !== null && d > 0 && t.scoring && t.scoring.length && t.nullCards === 0) {
                    const b = famBase(obs.hands, t.fam);

                    calibrate(t.fam, t.scoring, b.chips, b.mult, d, ctxOf(obs));
                }

                if (!phantom) {
                    bank.pred = afterC !== null ? afterC : bank.pred + credit;
                    bank.byFam[t.fam] = (bank.byFam[t.fam] || 0) + credit;
                }

                if (phantom) {
                    jw({ e: 'phantom', fam: t.fam, pred: t.pred });
                }
            }

            idle = 0;
            continue;
        }

        // unlock/gameover banners: dismiss via any continue-ish control
        if (ph === 'overlay') {
            const cu = (obs.controls || []).find((c) => c.enabled && /continue|done|dismiss/i.test(`${c.kind} ${c.label || ''}`));

            if (cu) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: cu.id });

                if (!r.ok) {
                    await sleep(1_200);
                }

                continue;
            }

            // stranded in settings/pause menu: back out
            const settingsUI = (obs.controls || []).some((c) => ['change_tab', 'option_cycle', 'toggle_button'].includes(c.kind));

            const bk = settingsUI ? (obs.controls || []).find((c) => c.enabled && /close|exit|back|resume/i.test(`${c.kind} ${c.label || ''}`)) : null;

            if (bk) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: bk.id });

                if (!r.ok) {
                    await sleep(1_200);
                }

                continue;
            }
        }

        if (['menu', 'blind_select', 'options', 'overlay'].includes(ph) && policy().speedSet !== true) {
            if (await setGameSpeed(obs)) {
                continue;
            }
        }

        if (ph === 'blind_select') {
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
                phase: ph, money: obs.run?.money, slotFreeNumber: cLimit,
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

            jw({ e: 'blind', ante: obs.run?.ante, name: obs.run?.blind?.name || (obs.run?.blinds || []).map((b) => `${b.name}:${b.state}`).join(','), target: obs.run?.blind?.target, effect: obs.run?.blind?.effect, jokers: ((obs.jokers || []).map((j) => j.name || j.key)), cons: ((obs.consumables || []).map((c) => `${c.name}[${(c.actions || []).join('/')}]`)), boss: boss && { name: boss.name, effect: boss.effect, target: boss.target } });

            if (sel) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: sel.id });

                if (!r.ok) {
                    say('select fail', r.error?.code);
                }

                continue;
            }
        }

        if (ph === 'round_won' || (obs.controls || []).some((c) => c.enabled && c.kind === 'cash_out')) {
            // telemetry only: tot mixes predicted transition credit; jokerFactor learns ONLY from exact same-blind deltas
            const tot = Object.values(bank.byFam || {}).reduce((s, v) => s + v, 0);
            const tgt = bank.target || 0;

            if (tot > 0 && tgt > tot) {
                jw({ e: 'learn', tgt, tot, ratio: +(tgt / tot).toFixed(2), fams: bank.byFam });
            }

            const c = (obs.controls || []).find((c) => c.enabled && c.kind === 'cash_out');

            if (c) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: c.id });

                if (!r.ok) {
                    say('cashout fail', r.error?.code);
                }

                continue;
            }
        }

        if (ph === 'shop') {
            let { obs: after } = await handleShop(obs);

            for (let t = 0; t < 8 && ['shop', 'pack'].includes(after.phase || ''); t++) {
                if ((after.phase || '') === 'pack') {
                    await handlePackOpen(after);
                    after = await observe();
                    continue;
                }

                const nr = (after.controls || []).find((c) => c.enabled && c.kind === 'next_round');
                const tg = (after.controls || []).find((c) => c.enabled && c.kind === 'toggle_shop');
                const c2 = (after.controls || []).find((c) => c.enabled && /next|leave|exit|continue/i.test(c.kind));
                const pick = nr || tg || c2;

                if (!pick) {
                    break;
                }

                const r = await act({ epoch: after.epoch, action: 'activate', target: pick.id });

                if (!r.ok) {
                    await sleep(1_500);
                    after = await observe();
                    continue;
                }

                after = r.result;
            }

            continue;
        }

        // booster opened at top level (skip_booster visible)
        if (ph === 'pack') {
            await handlePackOpen(obs);
            continue;
        }

        if (ph === 'game_won' || ph === 'game_over') {
            const won = ph === 'game_won';
            const stakeNum = obs.run?.stake ?? curStake;
            const lbl = pendingStakeLabel || Object.entries(stakeMap).find(([, v]) => v === stakeNum)?.[0]
                || (stakeNum >= 1 && stakeNum <= 8 ? STAKE_LABELS[stakeNum - 1] : null);

            resF.write(`${JSON.stringify({ t: Date.now(), rid: runSeq, won, ante: obs.run?.ante, round: obs.run?.round, stake: stakeNum, stakeLabel: lbl, deck: obs.run?.deck?.key ?? curDeckKey })}\n`);
            jw({ e: 'runend', won, ante: obs.run?.ante, round: obs.run?.round });
            say('RUN END', won ? 'WON' : 'lost', 'ante', obs.run?.ante, 'stake', lbl ?? stakeNum);

            if (won && lbl) {
                wins.add(lbl);
                saveWins();

                if (stakeNum !== null && stakeNum !== undefined) {
                    stakeMap[lbl] = stakeNum;
                    saveStakeMap();
                }

                say('recorded win for', lbl);
            }

            pendingStakeLabel = null;
            strat = null;
            bias = {};
            lastStratFam = null;
            bank = { key: '', pred: 0 };

            for (const k of Object.keys(suitTally)) {
                delete suitTally[k];
            }

            for (const k of Object.keys(jokerFactor)) {
                delete jokerFactor[k];
            }

            const nr = (obs.controls || []).find((c) => c.enabled && /setup_run|new_run/i.test(c.kind));

            if (nr) {
                await act({ epoch: obs.epoch, action: 'activate', target: nr.id });
                await sleep(1_500);
                continue;
            }
        }

        if (ph === 'overlay' || (obs.overlay)) {
            const r = await handleNewRun(obs);

            if (r) {
                continue;
            }
        }

        if (ph === 'tutorial') {
            const s = (obs.controls || []).find((c) => c.enabled && /skip|tut_next/.test(c.kind));

            if (s) {
                await act({ epoch: obs.epoch, action: 'activate', target: s.id });
                continue;
            }
        }

        if (ph === 'menu') {
            const p = (obs.controls || []).find((c) => c.enabled && /start_run|setup_run/.test(c.kind));

            if (p) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: p.id });

                if (!r.ok) {
                    say('menu click fail', r.error?.code, 'ctl', p.kind);
                    await sleep(2_500);
                } else {
                    await sleep(1_500);
                }

                continue;
            }
        }

        if (ph === 'game_won' || ph === 'game_over') {
            const nr = (obs.controls || []).find((c) => c.enabled);

            if (nr) {
                await act({ epoch: obs.epoch, action: 'activate', target: nr.id });
                continue;
            }
        }

        jw({ e: 'phase?', ph, controls: (obs.controls || []).map((c) => c.kind + (c.enabled ? '' : '?')), pack: obs.pack?.length });
        say('unhandled phase', ph, JSON.stringify((obs.controls || []).map((c) => `${c.kind}/${c.enabled}`)).slice(0, 200));
        await sleep(2_500);

        if (++idle > 8) {
            say('stuck 8x, sleeping long');
            await sleep(30_000);
            idle = 0;
        }
    }
}

// pure-function check (no host child needed until these modules load)
if (process.argv.includes('--selftest')) {
    const { evalHand } = await import('./lib/eval.mjs');
    const { predict, calibrate, knownLayer, ctxOf } = await import('./lib/play.mjs');
    /**
     * Build a minimal selectable card for the evaluator selftest.
     *
     * @param {string} rank - card rank label
     * @param {string} suit - card suit label
     * @returns {object} card-like object with a select action
     */
    const C = (rank, suit) => ({ rank, suit, actions: ['select'] });
    /**
     * Assert evalHand maps the given card pairs to the expected hand family.
     *
     * @param {string[][]} f - [rank, suit] pairs
     * @param {string} m - expected hand family name
     */
    const a = (f, m) => {
        const got = evalHand(f.map(([r, s]) => C(r, s)));

        if (got.fam !== m) {
            throw new Error(`eval ${m} got ${got.fam} for ${JSON.stringify(f)}`);
        }
    };

    a([['Ace', 'Hearts'], ['King', 'Hearts'], ['Queen', 'Hearts'], ['Jack', 'Hearts'], ['10', 'Hearts']], 'Straight Flush');
    a([['9', 'Hearts'], ['8', 'Hearts'], ['7', 'Hearts'], ['6', 'Hearts'], ['5', 'Hearts']], 'Straight Flush');
    a([['7', 'Hearts'], ['7', 'Spades'], ['7', 'Diamonds'], ['7', 'Clubs'], ['2', 'Hearts']], 'Four of a Kind');
    a([['8', 'Hearts'], ['8', 'Spades'], ['8', 'Diamonds'], ['3', 'Clubs'], ['3', 'Hearts']], 'Full House');
    a([['2', 'Spades'], ['5', 'Spades'], ['7', 'Spades'], ['9', 'Spades'], ['K', 'Spades']], 'Flush');
    a([['4', 'Hearts'], ['5', 'Spades'], ['6', 'Diamonds'], ['7', 'Clubs'], ['8', 'Hearts']], 'Straight');
    a([['Ace', 'Hearts'], ['2', 'Spades'], ['3', 'Diamonds'], ['4', 'Clubs'], ['5', 'Hearts']], 'Straight');
    a([['J', 'Hearts'], ['J', 'Spades'], ['J', 'Diamonds'], ['4', 'Clubs'], ['9', 'Hearts']], 'Three of a Kind');
    a([['6', 'Hearts'], ['6', 'Spades'], ['Q', 'Hearts'], ['Q', 'Diamonds'], ['2', 'Clubs']], 'Two Pair');
    a([['K', 'Hearts'], ['K', 'Spades'], ['2', 'Hearts'], ['7', 'Diamonds'], ['9', 'Clubs']], 'Pair');
    a([['K', 'Hearts'], ['3', 'Spades'], ['2', 'Hearts'], ['7', 'Diamonds'], ['9', 'Clubs']], 'High Card');
    const pred = predict([{ name: 'Flush', chips: 60, mult: 6, level: 2 }], 'Flush', [C('K', 'Spades'), C('2', 'Spades'), C('5', 'Spades'), C('7', 'Spades'), C('9', 'Spades')]);

    if (pred.score !== (60 + 10 + 2 + 5 + 7 + 9) * 6) {
        throw new Error(`predict ${pred.score}`);
    }

    if (evalHand([C('2', 'Hearts'), C('2', 'Spades')]).fam !== 'Pair') {
        throw new Error('2-card pair');
    }

    const fd = allSubsetEvals([{ rank: null, suit: null, actions: ['select'] }, { rank: null, suit: null, actions: ['select'] }, C('K', 'Hearts'), C('K', 'Spades'), C('2', 'Diamonds')], [{ name: 'Pair', chips: 10, mult: 2, level: 1 }]);

    // null-rank cards must not beat the real Kings
    if (fd[0].fam !== 'Pair' || fd[0].pred !== 60) {
        throw new Error(`facedown eval: ${fd[0].fam}/${fd[0].pred}`);
    }

    const uTab = [{ name: 'Pair', chips: 10, mult: 2, level: 1 }];
    const uCards = [{ id: 1, rank: 'K', suit: 'Hearts', actions: ['select'] }, { id: 2, rank: 'K', suit: 'Spades', actions: ['select'] }];
    const uRaw = predict(uTab, 'Pair', uCards).score;
    const u = allSubsetEvals(uCards, uTab, { Pair: 2 });

    if (u[0].fam !== 'Pair' || u[0].pred !== uRaw || u[0].util !== uRaw * 2) {
        throw new Error(`util/pred split: pred=${u[0].pred} util=${u[0].util} raw=${uRaw}`);
    }

    calibrate('Pair', [C('K', 'H'), C('K', 'S')], 10, 2, 600);

    if (Math.abs(jokerFactor.Pair - 10) > 1e-9) {
        throw new Error(`cal ${jokerFactor.Pair}`);
    }

    const tabHC = [{ name: 'High Card', chips: 5, mult: 1, level: 1 }];
    const kSc = [C('K', 'Hearts')];
    const obsM0 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 0 }, hands: [] });
    const obsM3 = ctxOf({ jokers: [{ name: 'Mystic Summit' }, { name: 'Mystic Summit' }], run: { discards_left: 3 }, hands: [] });
    const mysticOn = predict(tabHC, 'High Card', kSc, obsM0).score;
    const mysticOff = predict(tabHC, 'High Card', kSc, obsM3).score;

    if (mysticOff !== predict(tabHC, 'High Card', kSc).score || mysticOn !== mysticOff * 31) {
        throw new Error(`mystic gate/stack ${mysticOn}/${mysticOff}`);
    }

    const photo = predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Photograph' }, { name: 'Photograph' }], run: { discards_left: 1 }, hands: [] })).score;

    if (photo !== mysticOff * 4) {
        throw new Error(`photograph stacking ${photo}`);
    }

    const ancX = knownLayer('Flush', [C('2', 'Hearts'), C('5', 'Hearts'), C('7', 'Hearts'), C('9', 'Hearts'), C('J', 'Hearts')], ctxOf({ jokers: [{ name: 'Ancient Joker' }], run: { discards_left: 1 }, hands: [] })).xm;

    if (Math.abs(ancX - (3 + 1.5 ** 5) / 4) > 1e-9) {
        throw new Error(`ancient suit expectation ${ancX}`);
    }

    const fibC = [C('A', 'Hearts'), C('K', 'Hearts')];
    const fibP = predict(tabHC, 'High Card', fibC, ctxOf({ jokers: [{ name: 'Fibonacci' }, { name: 'Fibonacci' }], run: { discards_left: 1 }, hands: [] })).score;
    const fibNone = predict(tabHC, 'High Card', fibC).score;

    if (fibP !== fibNone * 17) {
        throw new Error(`fibonacci mult stack ${fibP}/${fibNone}`);
    }

    if (predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Fibonacci' }], run: { discards_left: 1 }, hands: [] })).score !== mysticOff) {
        throw new Error('fibonacci fired on non-fib rank');
    }

    const snova = predict(tabHC, 'High Card', kSc, ctxOf({ jokers: [{ name: 'Supernova' }], run: { discards_left: 1 }, hands: [{ name: 'High Card', played: 4 }] })).score;

    if (snova !== mysticOff * 6) {
        throw new Error(`supernova current-play off-by-one ${snova}`);
    }

    const tHand = [
        { id: 1, rank: 'K', suit: 'Hearts', actions: ['select'] },
        { id: 2, rank: 'Q', suit: 'Spades', actions: ['select'] },
        { id: 3, rank: '2', suit: 'Clubs', actions: ['select'] },
        { id: 4, rank: '7', suit: 'Diamonds', actions: ['select'] },
    ];
    /**
     * One tarot consumable fixture for the plan selftest.
     *
     * @param {string} name - tarot display name
     * @returns {object[]} consumable list
     */
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

    if (planTargeted({ hand: tHand, consumables: tCons('Death') }).length !== 0) {
        throw new Error('death must skip when best card is leftmost');
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

    console.log('SELFTEST OK');
    process.exit(0);
}

// anchor pre-run events (resumed run!) to a unique session rid; runstart supersedes it
setRunId(runSeq);
jw({ e: 'sessionstart', pid: process.pid });

main().catch((e) => {
    say('FATAL', e.message);
    process.exit(1);
});
