/* driver.mjs — autonomous Balatro grind: plays phases, shops, and the stake ladder on a chosen deck.
   Modules: lib/link (host stdio), lib/eval (hand eval), lib/play (prediction/discard), lib/shop, lib/settings, lib/knowledge (state/knobs).
   Monitor: out/state.json (current summary), out/log.jsonl (per-decision), out/results.jsonl (run outcomes). */
import fs from 'node:fs';
import path from 'node:path';
import { OUT, jw, setRunId, say, sleep, resF, wins, saveWins, stakeMap, saveStakeMap, STAKE_LABELS, policy, setStakeCtx, saveStakeLock, jokerFactor, jokerSig } from './lib/knowledge.mjs';
import { observe, act, nudgeUnpause } from './lib/link.mjs';
import { allSubsetEvals, chooseDiscard, calibrate, famBase, ctxOf, resetRoundReps, syncReps } from './lib/play.mjs';
import { handleShop, handlePackOpen, planetFam, resetShopRun, setPackMetaHands } from './lib/shop.mjs';
import { chooseStrategy, famBiasMap, jokerOrder, reorderNeeds, planConsumables, planTargeted } from './lib/strategy.mjs';
import { setGameSpeed } from './lib/settings.mjs';

// ---------- play-phase decision ----------

// per-blind score-accumulator estimate
let bank = { key: '', pred: 0 };
// consecutive playTurn act failures; 3 in a row => zombie-pause, CDP-Escape nudge
let turnErrStreak = 0;
// stake-abort in flight (Options opened, awaiting setup overlay -> new run)
let abandonPending = false;
let strat = null;
let bias = {};
let lastStratFam = null;
const suitTally = {};
// restart-unique: seeded from clock, +1 per run
let runSeq = Math.floor(Date.now() / 1_000);

/* true only when THIS session observed the runstart of the current run: a mid-run
   restart anchors the in-progress game run without runstart, making its digest
   partial (lvlAct/plays undercount) — flag it so watchers reject the fragment */
let sawRunStart = false;
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
            delete jokerSig[k];
        }
    }
}

let deckProbed = false;

/**
 * One-shot telemetry probe (while a Blue Joker is owned; retries until a non-empty
 * snapshot): dumps area kinds/counts PLUS a sanitized key/count scan of the whole
 * observation, so a top-level deck/draw field can't hide from the "unmodelable" claim.
 *
 * @param {object} obs - current observation
 * @returns {(string | null)} probe summary or null
 */
function deckProbe(obs) {
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

/**
 * Highlight cards, activate the matching control.
 *
 * @param {object} obs - current observation snapshot
 * @param {object[]} cards - cards to highlight
 * @param {string} kind - control kind to activate once cards are highlighted
 * @returns {Promise<object>} act result envelope
 */
async function execHighlight(obs, cards, kind) {
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
 * @returns {Promise<object>} observation after the attempt
 */
async function useTargeted(obs, tp) {
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

    syncReps(obs.hands);
    const preCtx = ctxOf(obs);

    if (anteRankAnte !== run.ante) {
        anteRank.clear();
        antePlayed.clear();
        anteRankAnte = run.ante;
    }

    if (/Pillar|Fish|Mark|House/.test(bname)) {
        /* SETTLED (68-obs census): Pillar DOES arrive with game-set debuffed flags -
           exactly the re-shuffled played copies, 1-6 per hand (0 only on the ante's
           first hand, correctly, before any plays). Fish/Mark/House raw stays 0:
           their mechanics are face-down/one-family, not per-card debuff in this
           bridge. lineage >=4 below is a conservative no-op floor, c.debuffed is
           the authority; keep dcens cheap to catch regression if the build changes */
        jw({ e: 'dcens', b: bname, raw: hand.filter((c) => c.debuffed).length, n: hand.length, led: Object.fromEntries(anteRank) });
    }

    if (bname === 'The Pillar') {
        for (const c of hand) {
            if ((anteRank.get(c.rank) ?? 0) >= 4) {
                c.debuffed = true;
            }
        }
    }

    let ev = allSubsetEvals(hand, obs.hands, bias, preCtx);

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

    /* The Mouth locks the WHOLE blind to the first play's family, and every later
       off-family hand is rejected for 0: prefer a REPEATABLE family (pairs-based
       hands recur from the same ranks) within 75% of the best pred. Run 1793026549
       locked Straight at 2930, could not repeat it, had three hands rejected and
       died 582 short with Two Pair candidates (2728) sitting in hand */
    if (mouthOnly && !bank.lockFam && ev.length) {
        const maxP = Math.max(...ev.map((o) => o.pred));
        const rep = ev.find((o) => ['Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'Four of a Kind'].includes(o.fam) && o.pred >= maxP * 0.75);

        if (rep && rep !== ev[0]) {
            ev = [rep, ...ev.filter((o) => o !== rep)];
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

        if (r.ok) {
            for (const c of five) {
                antePlayed.add(c.id);
            }
        }

        return { action: 'play', r, fam: '?', scoring: [], pred: 0, rem, preCtx, boss: bname };
    }

    const best = ev[0];
    /* FACE-DOWN HONEST SCALE (corpus calibration 804 runs: actual/pred median The Mark
       0.62, The Fish 0.56, The House 0.90 - virtual mid ranks overstate ~40%): shrink
       pred for the discard/fish thresholds only, so we fish faces instead of dumping
       hands at fantasy scores. Play-now uses real run.chips for rem, unaffected. */
    const faceDownF = hand.some((c) => c.rank === null || c.rank === undefined);
    const pEff = faceDownF ? best.pred * 0.6 : best.pred;

    /* The Pillar ("Cards played previously this Ante are debuffed" — ef text) debuffs
       ALL FOUR copies of any rank played earlier this ante — copies return from the
       discard pile into later draws already dead, and the game never sets the
       debuffed FLAG (verified via 27347-era deaths: id-lineage was observation-positional
       and missed every re-drawn copy). Rank counts >=4 => in-hand copies are dead;
       mark them debuffed pre-eval so predictions and family choice avoid them. */
    if (bname === 'The Pillar' && discLeft > 0 && pEff < rem) {
        const inBest = new Set(best.cards.map((c) => c.id));
        const dead = hand.filter((c) => ((anteRank.get(c.rank) ?? 0) >= 4 || c.debuffed) && (c.actions || []).includes('select') && !inBest.has(c.id));

        if (dead.length) {
            const r0 = await execHighlight(obs, dead.slice(0, 5), 'discard_cards_from_highlighted');

            if (r0.ok) {
                return { action: 'discard', r: r0, n: dead.length };
            }
        }
    }

    /* The Mouth (71854: hands 2-4 with FRESH families scored 0 - "the first played
       hand of the round is the only hand which can score"): the blind rides on the
       first hand, so pace it as all-or-nothing and fish discards into it instead of
       dividing the target by handsLeft and playing a 5500-vs-22000 hand "on budget" */
    const needPer = bname === 'The Mouth' && !bank.lockFam ? rem : rem / Math.max(1, handsLeft);
    /* FISH THE LAST HAND (Needle class: 13 deaths with dl=4 untouched - the old
       handsLeft>1 guard made Needle discard dead weight): when the projected hand
       falls short of the score needed in the hands remaining, spend discards to
       upgrade it. A discard cannot lose the round - only the play can - so this
       is strictly free equity (Water's no-discard fail just falls through) */
    const needMore = discLeft > 0 && pEff < needPer;

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

    if (r.ok && Array.isArray(r.result?.hands)) {
        syncReps(r.result.hands);
    }

    if (r.ok) {
        for (const c of best.cards) {
            antePlayed.add(c.id);

            if (c.rank) {
                anteRank.set(c.rank, (anteRank.get(c.rank) ?? 0) + 1);
            }
        }
    }

    if (mouthOnly && r.ok && !bank.lockFam) {
        bank.lockFam = best.fam;
    }

    if (eyeNoRep && r.ok) {
        (bank.eyeFams = bank.eyeFams || {})[best.fam] = 1;
    }

    return { action: 'play', r, fam: best.fam, scoring: best.scoring, cards: best.cards, pred: best.pred, rem, preCtx, boss: bname };
}

/**
 * Which family this hand will actually play (used to pick the matching planet BEFORE playing).
 *
 * @param {object} obs - current observation
 * @returns {(string | null)} family name or null
 */
function peekPlayFam(obs) {
    syncJokerSig(obs);
    syncReps(obs.hands);

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
    const stakeWant = STAKE_LABELS.indexOf(unwon) + 1;
    let o = obs;

    for (let round = 0; round < 40; round++) {
        const cycles = (o.controls || []).filter((c) => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options));
        /* PROVEN against the live setup overlay (13-start loop 10-29): indices are
           1-based (deck index 1 == "Red Deck" = game default; stake index 1 == stake 1
           = game's stake 1) and the STAKE control's options are NUMBERS [1..8], not
           label strings - the old /stake/i label probe never matched, so the stake
           arrow was never clicked and every claimed stake was fiction */
        /**
         * Read an option label, compensating for the 1-based index reported by controls.
         *
         * @param {object} c - option_cycle control
         * @param {number} i - control-reported index
         * @returns {string} option label
         */
        // eslint-disable-next-line unicorn/consistent-function-scoping -- reads o.controls layout fresh per overlay
        const at = (c, i) => c.options[i - 1];
        const deckC = cycles.find((c) => c.options.some((s) => /deck/i.test(String(s))));
        const stakeC = cycles.find((c) => c !== deckC && c.options.length >= 2 && c.options.every((s) => {
            const v = Number(s);

            return Number.isInteger(v) && v >= 1 && v <= 8;
        }));
        let c = null;
        let ti = -1;

        if (deckC && at(deckC, deckC.index) !== wantDeck) {
            c = deckC;
            ti = deckC.options.indexOf(wantDeck);
        } else if (stakeC && Number(at(stakeC, stakeC.index)) !== stakeWant) {
            c = stakeC;
            ti = stakeC.options.findIndex((s) => Number(s) === stakeWant);
        }

        if (!c || ti < 0) {
            break;
        }

        const n = c.options.length;
        const cur = ((c.index - 1 + n) % n);
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

    const stakeCyc = (o.controls || []).find((c) => c.kind === 'option_cycle' && Array.isArray(c.options) && (c.options.some((s) => /stake/i.test(String(s))) || (c.options.length >= 2 && c.options.every((s) => {
        const v = Number(s);

        return Number.isInteger(v) && v >= 1 && v <= 8;
    }))));
    const rawStake = stakeCyc ? stakeCyc.options[stakeCyc.index - 1] : null;
    let stakeLbl = null;

    if (rawStake !== null && rawStake !== undefined) {
        stakeLbl = /stake/i.test(String(rawStake)) ? String(rawStake) : STAKE_LABELS[Number(rawStake) - 1] || null;
    }

    const start = (o.controls || []).find((c) => c.enabled && /start_setup_run/.test(c.kind));

    if (!start) {
        /* PAUSE MENU (opened by the stake-abort guard): its New Run button (kind
           setup_run) opens the real setup tab with the deck/stake cycles +
           start_setup_run; the loop re-enters handleNewRun on that overlay */
        const sr = (o.controls || []).find((c) => c.enabled && c.kind === 'setup_run');

        if (sr) {
            jw({ e: 'setupopen' });
            await act({ epoch: o.epoch, action: 'activate', target: sr.id });

            return true;
        }

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
    sawRunStart = true;
    abandonPending = false;
    strat = null;
    bias = {};
    lastStratFam = null;
    bank = { key: '', pred: 0 };

    for (const k of Object.keys(jokerFactor)) {
        delete jokerFactor[k];
        delete jokerSig[k];
    }

    for (const k of Object.keys(suitTally)) {
        delete suitTally[k];
    }

    for (const k of Object.keys(runStats.fams)) {
        delete runStats.fams[k];
    }

    runStats.lvl = 0;
    runStats.acts.length = 0;
    runStats.jmax = 0;
    handsSnap = [];
    resetShopRun();
    deckProbed = false; /* one probe per RUN: the first Blue snapshot only showed key
                           shapes (deck(6) object at top level, no deck AREA) — reopen
                           the question each run until a probe settles Blue's modelability */

    await sleep(800);

    return true;
}

// ---------- main loop ----------
let curStake = null;

/* per-run accumulator: digested at game end into out/digests.jsonl (report-only;
   policy stays untouched — repeated-window signals get a manual one-lever change) */
const runStats = { lvl: 0, acts: [], jmax: 0, fams: {} };

/* last non-empty hands table seen this run: game_over obs sometimes arrives with
   hands:[] and the digest then lies about levels (run 1793034476: lvlAct 1 with
   lvlMap '' though the Saturn take had applied); snapshot backfills it */
let handsSnap = [];
let curDeckKey = null;
/* card ids + rank counts played earlier THIS ANTE (cleared when run.ante changes;
   NOTE shops fall after EVERY blind, not only bosses — Pillar's debuff spans Small->Big->Boss) */
const antePlayed = new Set();
/* Pillar v2 (27347-era: id lineage fails — bridge ids are observation-positional).
   dcens census settled the flag question: the game flags the EXACT re-shuffled played
   copies (raw 1-6/hand), NOT all four copies of a played rank - so >=4-rank lineage is
   a conservative floor that can only fire on ranks that can no longer legally appear
   (harmless safety net), while c.debuffed carries the truth the discard/eval paths
   already honor (never spend the grind on a family whose legs are flagged copies) */
const anteRank = new Map();
let anteRankAnte = null;

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
        setStakeCtx(obs.run?.stake ?? null);

        /* STAKE GUARD (user directive 10-29; wins-file array bug let the driver
           replay White through the whole Red era): if the live run's stake differs
           from the ladder target, abandon via Options -> New Run; setupopen +
           setupUI then drive the wanted-stake start */
        const wantSt = STAKE_LABELS.indexOf(STAKE_LABELS.find((l) => !wins.has(l)) || STAKE_LABELS[7]) + 1;
        const liveSt = obs.run?.stake ?? null;

        if (!abandonPending && liveSt !== null && liveSt !== wantSt && ['blind_select', 'hand', 'play', 'shop', 'cash_out'].includes(ph)) {
            const opt = (obs.controls || []).find((c) => c.enabled && c.kind === 'options');

            if (opt) {
                jw({ e: 'stakeabort', got: liveSt, want: wantSt, ph });
                abandonPending = true;
                await act({ epoch: obs.epoch, action: 'activate', target: opt.id });
                continue;
            }
        }

        if ((ph === 'hand' || ph === 'play') && obs.run) {
            curStake = obs.run.stake;
            curDeckKey = obs.run.deck?.key;

            const bkey = `${obs.run.round}:${obs.run.blind?.name || ''}`;

            if (bank.key !== bkey) {
                bank = { key: bkey, pred: 0, byFam: {}, eyeFams: {}, target: obs.run.blind?.target ?? 0 };
                resetRoundReps();
            }

            /* Blind still alive with bank >= target => banked predictions overshot reality (no current_score in this build);
               true score is < target, so re-anchor to zero instead of believing the phantom "already won". */
            if (bank.target > 0 && bank.pred >= bank.target) {
                jw({ e: 'resync', bank: Math.round(bank.pred), target: bank.target });
                // only bound while blind alive: real score < target; keep zero (no real score field in this build)
                bank.pred = 0;
            }

            /* PLANET BANKRUPT FIX (164: Jupiter+Saturn sat [use] all of a3-a5 while the
               engine grinded L2 and died pred 90 - the peek-match gate meant a held
               planet only fires if its OWN fam plays this turn, which almost never
               repeats; levels are permanent, waiting buys nothing). Exception kept:
               level-decay bosses (The Arm erodes per play) - bank while it is up. */
            const pf = peekPlayFam(obs);
            const armUp = /decrease level/i.test((obs.run?.blind?.effect || []).join(' '));
            const pls = (obs.consumables || []).filter((c) => String(c.kind || '').toLowerCase() === 'planet' && (c.actions || []).includes('use'));
            const pc = (pf && pls.find((c) => planetFam(c) === pf)) || (!armUp ? pls[0] : null);
            const pfam = pc ? planetFam(pc) : null;

            if (pc) {
                const r = await act({ epoch: obs.epoch, action: 'use', target: pc.id });

                if (r.ok) {
                    obs = r.result;
                    jw({ e: 'planet', fam: pfam });
                    runStats.lvl++;
                }
            }

            // targeted tarot on hand cards: select then use (Magician/Empress/Tower/Death/Hierophant)
            const ttPlans = planTargeted(obs, suitTally);

            /* Death-v3 PROVEN LIVE (1793089229 a1 Psychic: 'death leftcopy->best'
               ok:true on K-D/Q-D descending pair, consumed same blind) - the diag
               probe that surfaced the rank-ordering root cause is retired. */
            for (const tp of ttPlans) {
                obs = await useTargeted(obs, tp);
            }

            const before = obs.run.chips ?? null;

            if ((obs.hands || []).length) {
                handsSnap = obs.hands;
                setPackMetaHands(obs.hands);
            }

            jw({ e: 'turn', hand: (obs.hand || []).map((c) => [c.id, c.rank, c.suit, (c.actions || []).join('/'), c.debuffed ? 'D' : '', (c.enhancements || []).concat(c.key && c.key !== 'c_base' ? [c.key] : [], c.values && c.values.type ? [`t:${c.values.type}`] : [], c.seal ? [`S:${c.seal}`] : [], (c.values && c.values.seal) ? [`S:${c.values.seal}`] : []).join('|')]), chips: obs.run.chips, epoch: obs.epoch, dl: obs.run.discards_left ?? null, hl: obs.run.hands_left ?? null, jk: (obs.jokers || []).map((j) => [j.name, j.value ?? null, j.extra ?? null, j.values ?? null]), rerolls: obs.run.rerolls_left ?? obs.run.rerolls ?? null });
            const t = await playTurn(obs);

            t.nullCards = (obs.hand || []).filter((c) => !c.rank).length;
            jw({ e: 'decide', a: t.action, fam: t.fam, pred: t.pred, rem: t.rem, n: t.n, ante: obs.run?.ante, stk: obs.run?.stake ?? curStake, b: obs.run?.blind?.name, tgt: obs.run?.blind?.target ?? null, rchips: t.r && t.r.ok ? (t.r.result.run?.chips || before) : null, err: t.r && !t.r.ok ? t.r.error?.code : null, ef: Object.keys(bank.eyeFams || {}).join('/'), lk: bank.lockFam || '' });

            if (t.r?.ok && t.action === 'play' && t.fam) {
                runStats.fams[t.fam] = (runStats.fams[t.fam] || 0) + 1;
            }

            const dp = deckProbe(obs);

            if (dp) {
                jw({ e: 'deckprobe', areas: dp });
            }

            if (t.r && !t.r.ok) {
                say('turn err', t.r.error?.code);

                /* ZOMBIE-PAUSE ESCAPE (a8 Bell win rescue 10-29): game rejects every
                   in-hand action while phase/overlay/ready all look clean; only a real
                   Escape key wakes it. Three consecutive turn failures = stuck, not
                   an epoch race — nudge over CDP; the overlay handler does Back-next */
                if (++turnErrStreak >= 3) {
                    jw({ e: 'unstick', code: t.r.error?.code, streak: turnErrStreak });
                    await nudgeUnpause();
                    turnErrStreak = 0;
                }

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
                /* HONEST-SCALE BANKING (Mark med .58 / Fish .56 post-pEff: gate scale was
                   shipped but the bank kept folding raw preds -> 2x phantom overshoot ->
                   resync->0 every fd blind, needMore fed by fiction): credit face-down
                   plays at the same 0.6 pEff factor from the SAME evidence (EV medians
                   .56-.62 of raw pred), so resync fires on reality */
                let credit = d !== null ? d : t.pred;

                if (d === null && t.nullCards > 0) {
                    credit = (t.pred ?? 0) * 0.6;
                }

                // face-down (Fish/Mark) hands score under guessed fams — never fold their deltas into jokerFactor
                /* The Flint now halved in predict, but rounding of the halved base is
                   still guessed — keep skipping its calibration until a live Flint run
                   matches; The Arm debuffs played-hand LEVELS mid-blind (build text),
                   whose table reflection is unverified: fold neither into jokerFactor */
                if (d !== null && d > 0 && t.scoring && t.scoring.length && t.nullCards === 0 && !/flint|the arm/i.test(t.boss || '')) {
                    const b = famBase(obs.hands, t.fam);

                    calibrate(t.fam, t.scoring, b.chips, b.mult, d, { ...(t.preCtx ?? ctxOf(obs)), played: t.cards });
                }

                if (!phantom) {
                    bank.pred = afterC !== null ? afterC : bank.pred + credit;
                    bank.byFam[t.fam] = (bank.byFam[t.fam] || 0) + credit;
                }

                if (phantom) {
                    jw({ e: 'phantom', fam: t.fam, pred: t.pred });
                }
            }

            if (t.r?.ok) {
                turnErrStreak = 0;
            }

            idle = 0;
            continue;
        }

        // unlock/gameover banners: dismiss via any continue-ish control
        if (ph === 'overlay') {
            const setupUI = (obs.controls || []).some((c) => /setup_run|start_setup_run/.test(c.kind)
                || (c.kind === 'option_cycle' && Array.isArray(c.options) && c.options.some((s) => /deck|stake/i.test(String(s))))
                /* the New Run tab marker is present from the FIRST overlay frame, while the
                   deck/stake option rows lag one animation tick - without this the back-out
                   guard below ate the user's physical PLAY click (10-29 dismissal) */
                || (c.kind === 'change_tab' && /new run/i.test(String(c.label ?? ''))));
            const cu = !setupUI && (obs.controls || []).find((c) => c.enabled && /continue|done|dismiss/i.test(`${c.kind} ${c.label || ''}`));

            if (cu) {
                const r = await act({ epoch: obs.epoch, action: 'activate', target: cu.id });

                if (!r.ok) {
                    await sleep(1_200);
                }

                continue;
            }

            // stranded in settings/pause menu: back out
            const settingsUI = (obs.controls || []).some((c) => ['change_tab', 'option_cycle', 'toggle_button'].includes(c.kind));

            const bk = !setupUI && settingsUI ? (obs.controls || []).find((c) => c.enabled && /close|exit|back|resume/i.test(`${c.kind} ${c.label || ''}`)) : null;

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

            /* ctrl: Director's Cut is bought 29x and NEVER used - the boss-reroll affordance
               at blind select is unprobed; log every control kind (and enabled bit) plus the
               run-object key union once per blind to find where redeemed vouchers surface */
            jw({ e: 'blind', ante: obs.run?.ante, m: obs.run?.money, name: obs.run?.blind?.name || (obs.run?.blinds || []).map((b) => `${b.name}:${b.state}`).join(','), target: obs.run?.blind?.target, effect: obs.run?.blind?.effect, jokers: ((obs.jokers || []).map((j) => j.name || j.key)), cons: ((obs.consumables || []).map((c) => `${c.name}[${(c.actions || []).join('/')}]`)), boss: boss && { name: boss.name, effect: boss.effect, target: boss.target }, ctrl: (obs.controls || []).map((c) => `${c.kind}${c.enabled ? '' : ':off'}`), rk: Object.keys(obs.run || {}).join(','), tv: JSON.stringify(obs.run?.tags ?? null).slice(0, 200), vv: JSON.stringify(obs.run?.vouchers ?? null).slice(0, 240) });
            runStats.jmax = Math.max(runStats.jmax, (obs.jokers || []).length);

            /* SKIP ECONOMY (probe 1793083050 a2 BB + Red Stake effect user-confirmed 10-29
               "Small Blind gives no reward money"): activate skip_blind => ok, blind flips
               to Skipped, boss advances, run.tags stays [] (this build grants NO skip tag) —
               skip = FREE blind clear, forfeiting only the reward. WHITE-era: small skip
               forfeited $3 (driver fought, correct). RED STAKE: small reward IS $0 ->
               skipping costs nothing and skips the fight; skip when money is already
               above the blind's reward. Boss blinds skip-disabled; big-blind skip stays
               OFF (reward $4 > $0, only Red's small is money-free) */
            const skip = (obs.controls || []).find((c) => c.enabled && c.kind === 'skip_blind');
            const redSmall = (obs.run?.stake ?? curStake) === 2 && skip
                && /Small Blind:Select/.test((obs.run?.blinds || []).map((b) => `${b.name}:${b.state}`).join(','));

            if (sel && redSmall) {
                jw({ e: 'redskip', ante: obs.run?.ante, m: obs.run?.money });
                const rs2 = await act({ epoch: obs.epoch, action: 'activate', target: skip.id });

                if (!rs2.ok) {
                    say('redskip fail', rs2.error?.code);
                }

                continue;
            }

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
            const shop = await handleShop(obs);

            runStats.acts.push(...(shop.actions || []));
            let after = shop.obs;

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

            const A = runStats.acts;
            const PNAME = /^(mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)/i;
            const lvlAct = runStats.lvl + A.filter((a) => /^planet:/.test(a)).length + A.filter((a) => /^take:/.test(a) && PNAME.test(a.slice(5))).length;
            /* focal = the game's OWN most-played-family counters (hands rows played/
               times_played — same signal Telescope uses); decision-row counting mislabels
               hands the game scored differently (rid ...180: bot logged TP x4, game rows
               showed Full House played=5, and the Earth take was in fact correct).
               runStats.fams only as fallback when the table lacks counters */
            const H = (obs.hands && obs.hands.length) ? obs.hands : handsSnap;
            const rowsP = (H || []).map((h) => ({ f: h.name, p: Number(h.played ?? h.times_played) || 0, lvl: Number(h.level) || 1 })).filter((r) => r.f && r.p > 0);
            const focal = rowsP.slice().sort((a, b) => b.p - a.p || b.lvl - a.lvl)[0] || null;
            const focalName = focal ? focal.f : (Object.entries(runStats.fams).sort((a, b) => b[1] - a[1])[0] || [null])[0];
            const focalPlaysN = focal ? focal.p : (focalName ? runStats.fams[focalName] : 0); /* eslint-disable-line no-nested-ternary */
            const focalLvl = focal ? focal.lvl : null;
            const lvlMap = (H || []).filter((h) => (Number(h.level) || 1) > 1).map((h) => `${h.name}:${h.level}`).join(',');
            const dig = {
                e: 'rundigest',
                won,
                ante: obs.run?.ante,
                focal: focalName,
                focalPlays: focalPlaysN,
                focalLvl,
                lvlMap,
                lvlAct,
                uses: runStats.lvl,
                rerolls: A.filter((a) => a === 'reroll').length,
                celestial: A.some((a) => a.startsWith('pack:') && /celestial/i.test(a)),
                jokers: runStats.jmax,
                alert: !won && focalLvl !== null && focalLvl <= 2 && focalPlaysN >= 8 ? 'LOW_FOCAL_LEVEL' : (!won && (obs.run?.ante ?? 0) >= 5 ? 'CHIP_GAP' : null), /* eslint-disable-line no-nested-ternary */
                complete: sawRunStart,
            };

            jw(dig);
            fs.appendFileSync(path.join(OUT, 'digests.jsonl'), `${JSON.stringify({ t: Date.now(), rid: runSeq, ...dig })}\n`);
            say('DIGEST', `focal=${dig.focal ?? '-'}L${dig.focalLvl ?? '?'} map=[${dig.lvlMap}] rerolls=${dig.rerolls} celestial=${dig.celestial ? 'y' : 'n'} jokers=${dig.jokers} alert=${dig.alert ?? '-'}`);
            sawRunStart = false;

            for (const k of Object.keys(runStats.fams)) {
                delete runStats.fams[k];
            }

            runStats.lvl = 0;
            runStats.acts.length = 0;
            runStats.jmax = 0;
            handsSnap = [];
            resetShopRun();

            if (won && lbl) {
                wins.add(lbl);
                saveWins();
                /* preserve the EXACT knob set that beat this stake; reruns of this
                   stake and inherited starts of higher stakes resolve via policy() */
                saveStakeLock(lbl, { ...policy(), lockedAt: Date.now() });
                say('policy locked for', lbl);

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
                delete jokerSig[k];
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
            const p = (obs.controls || []).find((c) => c.enabled && c.kind === 'start_run');

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

            // this build's menu setup_run (Play -> save overlay) crashes on authored WS click; needs a physical/CDP click
            say('menu idle: needs physical Play click to open run overlay');
            await sleep(3_000);
            continue;
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
    const { runSelftest } = await import('./tests/selftest.mjs');

    await runSelftest();
    process.exit(0);
}

// anchor pre-run events (resumed run!) to a unique session rid; runstart supersedes it
setRunId(runSeq);
jw({ e: 'sessionstart', pid: process.pid });

main().catch((e) => {
    say('FATAL', e.message);
    process.exit(1);
});
