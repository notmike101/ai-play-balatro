# WAKE_STATE — bounded handoff (update every wakeup; git-tracked)

Updated: 2026-11-06 ~22:5x. HEAD `fix(driver) inert-back escalation` (pushed; live sessionstart ~1794005217, verified decide-flow). Driver LIVE via loopdrv10. Host = driver child on :4180, single page. **Incident 22:3x CLOSED:** 2.7h play-dead — bg_157 probe left OPTIONS hub open; hub back inert -> driver escape-loop deadlocked; port stayed LISTEN while dead (port != liveness; sessionstart/process-tree is proof). CDP Escape recovered; regression guard = sig-repeat -> nudgeUnpause() escalation (driver.mjs:592).

## Ladder (from live out/wins.json)
`{}` — White-only (reboot wiped save; game save is authority). 0 wins / 217+ session attempts. Mastery clock: behavior-era began at C28-live sessionstart (~11-06 morning); every attempt in that era counts toward the 9/30 White window; 0 wins so far — NOT mastery, NOT reset unless gameplay code changes.

## Watcher ownership
- Persistent service `wake-loop` (tmp/wakeloop.sh): batch-commits out/digests+results every 6 runs, re-arms its own watchrun child. Owns batch commits — do not compete.
- My async-bash pingers: one alive (anchor 1793994981274, WATCH batch 7) + a second watchrun child at the SAME anchor (wake-loop's). Duplicate wake is dedupe-safe via cursor; on next fire keep one, retire dup. Pinger wakes ME (this session); no auto-reasoning beyond that.
- Last consumed digest `t` = 1794004751404 (newest on disk). Dedupe by rid+t, filter `t>=anchor` never file position. Mastery era so far includes 2 interrupted attempts (zombie 1793994892, deploy-kill 1794004663) — denominator counts them, wins/attempt + wins/wall-clock reported separately.

## Active experiment — C32-DOOM-SHADOW (status: collecting)
- Pre-registered: shadow doom flag on `need` rows (ante4: run-max play-best pred <3000; ante5: <5500), ts>=1793990343129 (sessionstart 1793990343129 = code-live). Offline calibration: median-a4 best<2500 catches 59% of a4 reachers, 98.6% never-a6; thresholds bumped for run-max.
- Sample now: 25 digests, 15 a4-need rows (5 flagged; gap-clean vs clean rows so far: flagged <=1309, clean >=3045).
- Gate to LIVE: >=150 a4 shop-need rows AND precision >=98% (flagged-at-a4-shop that reached a6 = 0) AND zero flags on runs that reached a6+ at any point. Checkpoint grading at 40/80/150 rows.
- LIVE form (if gate passes): a4 shop, doom -> Options(ctl)/Main Menu abandon + digest `aborted:true`; abandon is save-safe-PROVEN exit path (optsurvey 11-06: hand->Options id14->Main Menu id3; menu-phase Options has NO Main Menu row). Must still verify resume/overwrite semantics once on a real live abort; aborted runs stay in mastery denominator; report wins/attempt and wins/wall-clock separately.
- Falsifier: >=2% of flagged doomed runs reach a6 -> thresholds too loose -> widen gap, no live.

## Ranked candidates (max 3)
1. C32 grading -> live-abort (above).
2. a5 wall: engine plateau a4->a5 med 1.19x vs curve 2.2x; deep-L6 runs (828 TP L6) die a4 on score => joker-layer/syndrome ceiling, not levels. Next probe = cohort-17 rerun of run-max joker composite vs a6+ survivors (runs.db blind rows carry joker name arrays).
3. Behavior-preserving AUDIT wave due (C28 cohort concluded): zero-unused-exports + comment-accuracy pass, gated, zero doom-data effect.

## Parked / settled
- C31 live route-switch: DISPROVED-IN-SAMPLE (tools/route.mjs v2.1: contra ~10% but big-delta rows are shadow-roll-policy discard holes at pNow=0.88, not live upside). Shadow is research-only; do not wire to production (AGENTS verdict rule).
- C28 voucher-first: KEEP (n=35 gate). C27: reverted. Prediction accuracy: closed, med 1.00.
- Moon/Sun = suit converters; no chip cap; NO SUBAGENTS (user).

## One exact next action
Next wakeup: `node tools/dbimport.mjs` then re-count a4-need doom rows (query above, ts>=1793990343129). <150 -> WAIT (re-arm pinger only if none alive). >=150 -> run precision join vs rundigest (anteMax of flagged rids), adjudicate gate, then live-branch or widen thresholds.
