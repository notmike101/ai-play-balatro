/* driver.mjs — autonomous Balatro grind: plays phases, shops, and the stake ladder on a chosen deck.
   Modules: lib/link (host stdio), lib/eval (hand eval), lib/play (prediction/discard), lib/shop, lib/settings, lib/knowledge (state/knobs).
   Monitor: out/state.json (current summary), out/log.jsonl (per-decision), out/results.jsonl (run outcomes). */
import fs from 'node:fs';
import path from 'node:path';
import { OUT, jw, setRunId, say, sleep, resF, wins, saveWins, stakeMap, saveStakeMap, STAKE_LABELS, policy, setStakeCtx, saveStakeLock, jokerFactor, jokerSig } from './lib/knowledge.mjs';
import { observe, act, clickPage } from './lib/link.mjs';
import { handleShop, resetShopRun } from './lib/shop.mjs';
import { handlePackOpen } from './lib/packflow.mjs';
import { setGameSpeed } from './lib/settings.mjs';
import { buildDigest, resetRunStats } from './lib/digest.mjs';
import { resetProbe } from './lib/acts.mjs';
import { handleHand } from './lib/playturn.mjs';
import { resetSeen } from './lib/play.mjs';
import { currentBias, handleBlindSelect, resetStrategy } from './lib/blind.mjs';

// ---------- play-phase decision ----------

// per-blind score-accumulator estimate
let bank = { key: '', pred: 0 };
// consecutive playTurn act failures; 3 in a row => zombie-pause, CDP-Escape nudge
let turnErrStreak = 0;
// stake-abort in flight (Options opened, awaiting setup overlay -> new run)
let abandonPending = false;
let abortStreak = 0;
/* MECHANICS PROBES (user directive 10-30): interest + secret-hand validation, log-only */
let cashSeen = '';
let habsSeen = -2;
let lvlSig = '';
const suitTally = {};
// restart-unique: seeded from clock, +1 per run
let runSeq = Math.floor(Date.now() / 1_000);

/* true only when THIS session observed the runstart of the current run: a mid-run
   restart anchors the in-progress game run without runstart, making its digest
   partial (lvlAct/plays undercount) — flag it so watchers reject the fragment */
let sawRunStart = false;
// learned joker residual belongs to the lineup that produced it; lineup change invalidates all

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

        /* STAKE LOOP FORENSICS (10-30: 256 stakeaborts, game starts stake1 while
           runstart claims Red - fall-through-to-default start path suspected):
           capture EVERY overlay frame's control kinds + cycle states */
        jw({ e: 'ovl', round, ks: (o.controls || []).map((c) => `${c.kind}${c.enabled ? '' : '!'}${c.options ? `[${c.options.length}]@${c.index}{${c.options.slice(0, 5).join('/')}}` : `=${c.label ?? ''}`}`).join(';').slice(0, 700), run: Boolean(o.run) });

        /* Rows render a tick LATE on this overlay (observed 10-30: the first
           frame had NO option_cycle at all, so the old code broke straight to
           start and ran the game's DEFAULT stake - every claimed stake was
           fiction and the stake guard crash-looped on the White runs) */
        if (!cycles.length && round < 8) {
            await sleep(600);
            o = await observe();

            continue;
        }

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
        /* DECK-STYLED STAKE ROW DISABLED (10-30, oracle-confirmed): the second
           deck-label cycle IS a deck selector - clicking its arrows cycles DECKS
           (the 18:4x "oscillating @1<->@2" was our own double-clicking), never the
           stake. The real stake cycle only exists when the game has >1 stake
           UNLOCKED; this build's save lost the White win, so setup shows NO stake
           row and PLAY serves White. Numeric-cycle branch above stays the live path */
        let c = null;
        let ti = -1;

        if (deckC && at(deckC, deckC.index) !== wantDeck) {
            c = deckC;
            ti = deckC.options.indexOf(wantDeck);
        } else if (stakeC) {
            const first = Number(at(stakeC, stakeC.index));
            const stakeCur = Number.isInteger(first) ? first : stakeC.index;

            if (stakeCur !== stakeWant) {
                c = stakeC;
                ti = stakeC.options.findIndex((s) => Number(s) === stakeWant);
                if (ti < 0) {
                    ti = stakeWant - 1;
                }
            }
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

    /* DECK RE-SELECT (10-30 forensics): clicking the stake row's partner also flips
       the deck row (observed both cycles oscillating @1<->@2 in lockstep) - land the
       stake LAST and re-assert the wanted deck immediately before PLAY, else every
       second run starts Blue Deck (137447 rid 1793387361: stake arrows hit, deck lost) */
    {
        const deckC2 = (o.controls || []).find((c) => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options) && c.options.some((s) => /deck/i.test(String(s))));

        if (deckC2 && deckC2.options[deckC2.index - 1] !== wantDeck) {
            const ti2 = deckC2.options.indexOf(wantDeck);
            const dir2 = ti2 >= deckC2.index ? 'r' : 'l';
            const partner = cyclePartner(o.controls, deckC2, dir2);

            if (partner) {
                const rr = await act({ epoch: o.epoch, action: 'activate', target: partner.id });

                if (rr.ok) {
                    o = rr.result;
                }
            }
        }
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

    if (stakeLbl === null && stakeCyc) {
        /* deck-styled stake row (10-30 UI): options are deck labels, index is the stake */
        stakeLbl = STAKE_LABELS[stakeCyc.index - 1] ?? null;
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
    jw({ e: 'runstart', stake: stakeLbl || unwon, hasCyc: Boolean(stakeCyc), hadStart: Boolean(start) });
    sawRunStart = true;
    abandonPending = false;
    resetStrategy();
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
    resetSeen();
    resetProbe(); /* one probe per RUN (deck manifest shape settled: composition rows
                           give exact per-combo counts - Blue Joker now modeled on them) */

    await sleep(800);

    return true;
}

// ---------- main loop ----------
let curStake = null;

/* per-run accumulator: digested at game end into out/digests.jsonl (report-only;
   policy stays untouched — repeated-window signals get a manual one-lever change) */
const runStats = { gap: null, lvl: 0, acts: [], jmax: 0, fams: {} };

/* last non-empty hands table seen this run: game_over obs sometimes arrives with
   hands:[] and the digest then lies about levels (run 1793034476: lvlAct 1 with
   lvlMap '' though the Saturn take had applied); snapshot backfills it */
let handsSnap = [];
let curDeckKey = null;
/* card ids + rank counts played earlier THIS ANTE (cleared when run.ante changes;
   NOTE shops fall after EVERY blind, not only bosses — Pillar's debuff spans Small->Big->Boss) */
const antePlayed = new Set();
let menuClickTs = 0;
/* Pillar v2 (27347-era: id lineage fails — bridge ids are observation-positional).
   dcens census settled the flag question: the game flags the EXACT re-shuffled played
   copies (raw 1-6/hand), NOT all four copies of a played rank - so >=4-rank lineage is
   a conservative floor that can only fire on ranks that can no longer legally appear
   (harmless safety net), while c.debuffed carries the truth the discard/eval paths
   already honor (never spend the grind on a family whose legs are flagged copies) */
const anteRank = new Map();
let anteRankAnte = null;

/* live state view for the extracted hand-phase engine; bank is reassigned per blind/run,
   so expose them through getters rather than snapshotting into the module */
const turnState = {
    antePlayed,
    anteRank,
    /**
     * Ante whose rank tally is currently active.
     *
     * @returns {number | null} active tally ante
     */
    get anteRankAnte() {
        return anteRankAnte;
    },

    /**
     * Mark the active tally ante.
     *
     * @param {number | null} v - ante being tallied
     */
    set anteRankAnte(v) {
        anteRankAnte = v;
    },

    /**
     * Live per-blind bank (reassigned per blind/run, hence the getter).
     *
     * @returns {object} bank state
     */
    get bank() {
        return bank;
    },

    /**
     * Live family bias map (reassigned per blind, hence the getter).
     *
     * @returns {object} bias weights
     */
    get bias() {
        return currentBias();
    },

    /**
     * Stake of the run in progress (for stake-conditional play policy).
     *
     * @returns {number | null} current stake index
     */
    get stake() {
        return curStake;
    },
};

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

        /* CASH-OUT PANEL PROBE (user: "interest exists by default, there are absolute
           certainty"): dump the reward breakdown labels the panel shows per blind
           (Blind reward / Interest / Hands remaining ...) - settles the NO-interest
           claim in shop.mjs. One row per round, log-only. */
        if (ph === 'cash_out') {
            const ck = `${obs.run?.ante}|${obs.run?.round}`;

            if (cashSeen !== ck) {
                cashSeen = ck;
                jw({ e: 'cashout', ante: obs.run?.ante, round: obs.run?.round, money: obs.run?.money, blind: obs.run?.blind?.name, ctrls: (obs.controls || []).map((c) => `${c.kind}:${String(c.label ?? '').slice(0, 40)}`) });
            }
        }

        /* HANDS-TABLE PROBE: full rows incl hidden hands (Five of a Kind / Flush House /
           Flush Five) with game-reported base chips/mult - settles secret-hand presence.
           Once per ante; re-arms when a new run reaches a1/r0. */
        if (obs.run && obs.run.ante === 1 && obs.run.round === 0) {
            habsSeen = -1;
        }

        if (Array.isArray(obs.hands) && obs.hands.length && typeof obs.run?.ante === 'number' && obs.run.ante !== habsSeen) {
            habsSeen = obs.run.ante;
            jw({ e: 'handstab', ante: obs.run.ante, rows: obs.hands.map((h) => [h.name, h.level ?? null, h.chips ?? null, h.mult ?? null, h.played ?? null]) });
        }

        /* LEVEL-JUMP PROBE (user verify directive): the hands table is the game's own
           truth - log every level-map change the instant it is observed (planet take/use,
           Black Hole, The Arm decay). Attribute to the nearest preceding take/use row. */
        const lvsig = (obs.hands || []).map((h) => `${h.name}:${h.level ?? ''}`).join(',');

        if (lvsig && lvsig !== lvlSig) {
            if (lvlSig && obs.run) {
                jw({ e: 'lvljump', ante: obs.run.ante, sig: lvsig });
            }

            lvlSig = lvsig;
        }

        /* STAKE GUARD (user directive 10-29; wins-file array bug let the driver
           replay White through the whole Red era): if the live run's stake differs
           from the ladder target, abandon via Options -> New Run; setupopen +
           setupUI then drive the wanted-stake start */
        const wantSt = STAKE_LABELS.indexOf(STAKE_LABELS.find((l) => !wins.has(l)) || STAKE_LABELS[7]) + 1;
        const liveSt = obs.run?.stake ?? null;

        /* NEVER-FORGET LEDGER (10-30, after three ledger whiplash deploys): a
           genuine a8 win is permanent in wins.json; a game-side regression
           (unlock vanished, stake row gone) does NOT demote it - demotion made
           the driver "forget" a real White win every reload and oscillate the
           ladder. Target stays the ladder's next unwon stake; the abort guard
           tolerates the game's actual stake after 3 aborts (loop-bleed below);
           when the numeric stake row ever reappears, setup clicks the target. */

        /* LOOP-BLEED (10-30 incident): the setup tab lost its stake row (now only
           two DECK cycles + seeded toggle; stake was numeric-1..8 cycle on 10-29)
           so every PLAY starts stake1 and the guard abort-looped 256x in 25min.
           After 3 consecutive aborted-without-play runs, tolerate the stake the
           game gives and keep grinding; a run reaching ante>=2 plays resets it */
        if (!abandonPending && liveSt !== null && liveSt !== wantSt && abortStreak < 3 && ['blind_select', 'hand', 'play', 'shop', 'cash_out'].includes(ph)) {
            const opt = (obs.controls || []).find((c) => c.enabled && c.kind === 'options');

            if (opt) {
                jw({ e: 'stakeabort', got: liveSt, want: wantSt, ph });
                abandonPending = true;
                abortStreak += 1;
                await act({ epoch: obs.epoch, action: 'activate', target: opt.id });
                continue;
            }
        }

        if ((ph === 'hand' || ph === 'play') && obs.run) {
            curStake = obs.run.stake;
            if (curStake === wantSt) {
                abortStreak = 0;
            }
            curDeckKey = obs.run.deck?.key;

            const hh = await handleHand(obs, {
                st: turnState,
                runStats,
                suitTally,
                stake: curStake,
                /**
                 * Record the live hand-table snapshot for the run digest.
                 *
                 * @param {object[]} h - observation hands table
                 */
                onHands: (h) => {
                    handsSnap = h;
                },
                turnErrStreak,
            });

            turnErrStreak = hh.turnErrStreak;
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
            const br = await handleBlindSelect(obs, runStats);

            obs = br.obs;

            if (br.cont) {
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

            const dig = buildDigest({ obs, won, runStats, handsSnap, complete: sawRunStart });

            jw(dig);
            fs.appendFileSync(path.join(OUT, 'digests.jsonl'), `${JSON.stringify({ t: Date.now(), rid: runSeq, ...dig })}\n`);
            say('DIGEST', `focal=${dig.focal ?? '-'}L${dig.focalLvl ?? '?'} map=[${dig.lvlMap}] rerolls=${dig.rerolls} celestial=${dig.celestial ? 'y' : 'n'} jokers=${dig.jokers} alert=${dig.alert ?? '-'}`);
            sawRunStart = false;
            resetRunStats(runStats);
            handsSnap = [];
            resetShopRun();
            resetSeen();

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
            resetStrategy();
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

            /* this build's menu setup_run (Play -> save overlay) crashes on the
               authored WS click; a trusted CDP dispatch opens it (validated
               2026-10-30; PLAY sits at CSS 452,792 for the 1302x1077 @dpr1.5
               app window - re-check tools/vp.mjs + out/page4.png if resized) */
            if (Date.now() - menuClickTs > 20_000) {
                menuClickTs = Date.now();
                const okc = await clickPage(452, 792);

                jw({ e: 'menuclick', ok: okc });
                say('menu: CDP trusted PLAY click', okc);
            }

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
