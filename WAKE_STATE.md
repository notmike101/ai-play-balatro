# WAKE_STATE — bounded handoff (update every wakeup; git-tracked)

Updated: 2026-11-06 ~20:2x UTC-ish local. HEAD `5607d6a`. Driver LIVE (loopdrv10 service, sessionstart 1793995228872, pid 40440; driver = 2 node procs, legit). Host = driver child on :4180, single page.

## Ladder (from live out/wins.json)
`{}` — White-only (reboot wiped save; game save is authority). 0 wins / 217+ session attempts. Mastery clock: behavior-era began at C28-live sessionstart (~11-06 morning); every attempt in that era counts toward the 9/30 White window; 0 wins so far — NOT mastery, NOT reset unless gameplay code changes.

## Watcher ownership
- Persistent service `wake-loop` (tmp/wakeloop.sh): batch-commits out/digests+results every 6 runs, re-arms its own watchrun child. Owns batch commits — do not compete.
- My async-bash pingers (`T=$(node tools/wake.mjs|tail -1) && WATCH_N=7 node tools/watchrun.mjs "$T"`, timeout 3600 async): one stale pinger alive (anchor 1793994689120) — let it deliver, do NOT arm another until it fires. Pinger wakes ME (this session); no auto-reasoning beyond that.
- Last consumed digest `t` = 1793994981274 (wake.mjs tail line). Dedupe by rid+t, filter `t>=anchor` never file position.

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
