# WAKE_STATE — bounded handoff (update every wakeup; git-tracked)

Updated: 2026-11-06 ~05:0x (post mode-switch). **MODE: REASONING-DRIVEN (USER 11-06) — primary.** The agent plays every hand itself via host10; heuristics advisory only. Driver stack is DOWN by design: loopdrv10 + wake-loop services STOPPED, pingers none. Do not restart them while playing (single-owner bridge: host10 holds :4180).

## Mission / ladder state
- Advance stakes with **3 CONSECUTIVE wins on same stake** (loss/abort/crash = streak reset to 0). Ultimate goal: reach Gold. Game save = White-only (11-06 reboot wiped unlocks; wins.json `{}`).
- **Streak: White 0/3 — streak attempt #1 IN PROGRESS or next (record each outcome here immediately: mode/stake/ante-reached/why).**
- Pre-mode-switch driver-era stats (n~500 attempts, 0 wins, avgA ~3) = historical evidence that heuristic policy alone plateaus at a5/a6; NOT part of any streak ledger.

## Stack identity
- Chrome full-path headless, port 9222 (CDP) — UNTOUCHED, verify with `fetch http://127.0.0.1:9222/json/version`.
- **host10 service LIVE** (pid at start): `node automation-host.mjs --origin https://poker.gl.ax --stay-open`, cwd repo root, ready-port 4180; page connected (visibility player) — proof line `{"v":1,"event":"connected"}` in `read proc://host10`.
- Drive: write `{"v":1,"id":N,"op":"observe"}` to `proc://host10`; read replies from `proc://host10` (big payloads → artifact://). act uses LATEST epoch + observation-local ids. New Run: op `menu` → setup_run activate → change_tab 'New Run' → start_setup_run (see RUNBOOK Menu ops). Stake stays White until a progression win unlocks Red in the SAVE.
- Telemetry: reasoning runs write NO log.jsonl rows. Record outcomes in this file + status log by hand. CDP screenshot for proof: tmp pattern in status (fetch /json/list → Page.captureScreenshot).

## Rules of play (reasoning doctrine)
- Decide every play/discard/shop/pack/tarot by reasoning on the CURRENT observation (jokers, levels, economy, boss text, remaining hands/discards). Precompiled predictions (rchips etc.) are cross-checks, never the decider.
- Boss text governs (`blind` row effects; Settled facts in RUNBOOK). No vanilla-lore assumptions. Never spend the run-saving margin: clear small blinds cheaply, bank money/interest discipline per proven economy (buy when it compounds; reroll only when $ floor allows).
- One run at a time; NEVER leave a run unattended at a decision point (that's a stall = counts against nothing but wastes wall clock).

## Closed/settled (carry-forward)
- C32 doom dead; C31 parked; C28 voucher-first was driver policy (moot for reasoning mode but observations valid: voucher buys cheap power). Moon/Sun = suit converters. Flint halves BASE. NO SUBAGENTS (user). Gates/push/WAKE_STATE discipline unchanged.
- Ops traps: overlay back inert -> CDP Escape escalation; headless Chrome drops background mouse events -> CDP clicks on 9222; killdrv.ps1 at repo root (only for driver mode).

## One exact next action
If host10 connected: start/continue streak attempt on White via menu New Run; play hand-by-hand; on run end (win Ante-8 boss or death), log outcome in "Streak" line above + status-2026-11-06.md, commit push, immediately start next attempt (3 in a row to Red). If host10 dead: re-start per RUNBOOK Reasoning-driven mode section, verify `connected`, then resume.
