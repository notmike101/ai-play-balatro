# WAKE_STATE — bounded handoff (update every wakeup; git-tracked)

Updated: 2026-11-06 ~22:5x. HEAD `fix(driver) inert-back escalation` (pushed; live sessionstart ~1794005217, verified decide-flow). Driver LIVE via loopdrv10. Host = driver child on :4180, single page. **Incident 22:3x CLOSED:** 2.7h play-dead — bg_157 probe left OPTIONS hub open; hub back inert -> driver escape-loop deadlocked; port stayed LISTEN while dead (port != liveness; sessionstart/process-tree is proof). CDP Escape recovered; regression guard = sig-repeat -> nudgeUnpause() escalation (driver.mjs:592).

## Ladder (from live out/wins.json)
`{}` — White-only (reboot wiped save; game save is authority). 0 wins / 217+ session attempts. Mastery clock: behavior-era began at C28-live sessionstart (~11-06 morning); every attempt in that era counts toward the 9/30 White window; 0 wins so far — NOT mastery, NOT reset unless gameplay code changes.

## Watcher ownership
- Persistent service `wake-loop` (tmp/wakeloop.sh): batch-commits out/digests+results every 6 runs, re-arms its own watchrun child. Owns batch commits — do not compete.
- My async-bash pingers: bg_161 armed (anchor 1794012985522, N=7). TRUTH (11-06): nvm `node` shim RE-EXECutes v22.20 -> every watchrun shows as TWO processes at one anchor and can deliver the batch TWICE — single logical watcher, not double-arm; ignore dup deliveries (cursor dedupes). NEVER `&`-detach a pinger (output orphaned; kills lose delivery). Pinger wakes ME; no auto-reasoning beyond that.
- Last consumed digest `t` = 1794012985522 (newest on disk). Dedupe by rid+t, filter `t>=anchor` never file position. Mastery era so far includes 2 interrupted attempts (zombie 1793994892, deploy-kill 1794004663) — denominator counts them, wins/attempt + wins/wall-clock reported separately.

## Active experiment — AUDIT WAVE (status: due, in progress)
- C28 cohort concluded -> scheduled behavior-preserving audit per AGENTS cadence. Topics done this wave: RUNBOOK liveness triage (decide-age, not port) pushed; comment/doc accuracy re today's incidents. Remaining topic when next due: unused-export sweep (tools/deepx.mjs is deep-death census, NOT export census — export sweep needs `grep -rn "export " lib *.mjs` vs callers, cheap). Audit = docs/tools only, NEVER touch gameplay code mid-era; no driver restart needed.

## Closed experiments
- **C32 DOOM/EARLY-ABORT: DEAD** (11-06, full verdict in status-2026-11-04.md ~23:5x block). Sole era a6-survivor flagged doomed at EVERY threshold (a4-shop run-max 1309) and escaped on POST-a4 supply; jokers@ a4-shop census flat across depths (4.56/4.84/4.88, copier 16/19/15%, n=276 post-unlock) -> no live state distinguishes survivors; abort would kill the win tail (0/55 era, we hunt tails not medians). Doom field stays as telemetry; NO live switch will be wired.
- **C31 route-switch: PARKED** (shadow-policy holes, not live upside; route.mjs census 10% contra = roll-threshold artifacts).
- **C27 ceiling-targeting: REVERTED.** C28 voucher-first: KEEP (buy-rate 44->89%; depth gated by OFFER RNG).

## Ranked candidates (max 3)
1. AUDIT wave DONE (export sweep: 126 exports, cyclePartner demoted). Next audit topic: comment-accuracy re-check of shop.mjs/playturn.mjs against post-fix telemetry.
2. a5+ wall = post-a4 supply RNG (settled); remaining lever candidates ONLY if supply changes: reroll aggression at a5+ shops (money med high there) — needs its own shadow first; deepx census says 54% of 1703 deep-death runs carried >=1 xmult joker (synergy-vs-count question open, low priority).
3. WAIT for depth (avgA band 2.9-3.2 confirmed steady); mastery hunt = throughput x tail, driver already plays continuously.

## Parked / settled
- C31 live route-switch: DISPROVED-IN-SAMPLE (tools/route.mjs v2.1: contra ~10% but big-delta rows are shadow-roll-policy discard holes at pNow=0.88, not live upside). Shadow is research-only; do not wire to production (AGENTS verdict rule).
- C28 voucher-first: KEEP (n=35 gate). C27: reverted. Prediction accuracy: closed, med 1.00.
- Moon/Sun = suit converters; no chip cap; NO SUBAGENTS (user).

## One exact next action
Next wakeup: pinger fires on 7 new digests. Primary job = WAIT + verify liveness (decide age <10min + drv-stdout clean). Opportunistic: finish export-sweep audit topic (grep exports vs callers, delete dead, gate `selftest+lint`, commit `chore(deadcode):`-style, NO driver restart needed since exports unused == not loaded). Era stats snapshot each wake: wins + avgA on complete digests rid>=1793990343 (remember rid = epoch SECONDS).
