# WAKE_STATE — bounded handoff (update every wakeup; git-tracked)

Updated: 2026-11-07 ~02:1x (mid-streak). **MODE: REASONING-DRIVEN (USER 11-06) — primary.** The agent plays every hand itself via the host file relay + `node tools/hact.mjs`; heuristics advisory only. Driver stack is DOWN by design: loopdrv + wake-loop services STOPPED, pingers none. Do not restart them while playing (single-owner bridge: host service holds :4180). Headless Chrome = user's monitor stays free.

## Mission / ladder state
- Advance stakes with **3 CONSECUTIVE wins on same stake** (loss/abort/crash = streak reset to 0). Ultimate goal: reach Gold. Game save = White-only (11-06 reboot wiped unlocks; wins.json `{}` = mirror of game save).
- **Streak: White 0/3 — 18 losses; deepest = attempt 16 (a6 BB THE MOUTH 4932/22000 - cleared to a6 BB: Needle/Tooth/a5-boss down; Half Joker +20 with <=3-cards-played = fill-line; glass x2 + steel 1.5 stack = FH 8k hands; Mouth doctrine in ledger). Full per-attempt ledger: status-2026-11-06.md lines "N. LOSS/...". Playbook (learned 11-06/07):** joker-first - FIRST pack pick = add-mult joker (Gros Michel +15 proven backbone; plain Joker +4 = floor); Loyalty x4 (every 6th hand) = bonus trigger, NEVER the engine; splash/EVS keep even+face-rich best-5 lines; gamble whenever best-hold < needed/hands and discards remain (RULE v3); packs = `use` action; rescan ids before EVERY act. Held-card economy (11-07 t14): buy Standard/Celestial packs only - Stone +50 chips HELD (never play it), Steel x1.5 mult HELD, Glass x2 mult PLAYED; Arcana/Jumbo-Arcana whose offers are all target-gated (Lovers/Devil/Chariot/Star...) = UNPICKABLE via relay (use=action_unavailable, $4-$8 sunk - skip such packs fast); non-gated (Judgement, planets, Fool-type) pick fine. Face-down bosses (THE FISH: draws "undefined" after hand 1; The Wheel: faces shown anyway): hand 1 = maximize scored value visible, then play max-5 blind + save 1 discard for Swashbuckler +2. a5 boss class (~22k) needs engine ceiling ~4400/hand = planet the played family L4 + 3 held stones by a4. **t18 addendum (a4 boss 6579/7500): Half bought a1 = RULE v6 works (engine from hand 1) BUT Half boards cap ~a4 boss (1875/hand vs Half fills 608-1150): at boss blinds fish big lines (4-run/straight, two-pair FH fish) with h1 when target/hands > Half line; a5+ ceiling needs FH planets L3-4 + glass/steel economy (t16 pattern).**

- Pre-mode-switch driver-era stats (n~500 attempts, 0 wins, avgA ~3) = historical evidence that heuristic policy alone plateaus at a5/a6; NOT part of any streak ledger.

## Stack identity
- Chrome full-path headless, port 9222 (CDP) — UNTOUCHED, verify with `fetch http://127.0.0.1:9222/json/version`.
- **Host service = NAMED `host<N>` (last: `host12`)**, cwd repo root, ready-gate log `listening` + port 4180:
  `tail -F -n0 out/hostcmd.json | node automation-host.mjs --origin https://poker.gl.ax --stay-open | tee -a out/hostresp.log`
  Page proof line `{"v":1,"event":"connected"}` in out/hostresp.log. If restarting to play: kill host service FIRST before loopdrv (port 4180).
- Drive: `node tools/hact.mjs obs|act '<json>'|play <ids>|discard <ids>|ctl <kind>` (fresh epoch + stale retry; committed tool). Raw fallback: append op JSON line to out/hostcmd.json (bash printf, cwd repo root), scan out/hostresp.log newest-first (node -e + require('fs'); ESM import() one-liners die silently). New Run after death: `ctl notify_then_setup_run` -> `ctl start_setup_run` -> `ctl select_blind` (~6 s). Stake stays White until a progression win unlocks Red in the SAVE.
- Telemetry: reasoning runs write NO log.jsonl rows. Record outcomes in this file + numbered line in status-YYYY-MM-DD.md per attempt (commit per attempt). CDP screenshot for proof: tmp pattern in status (fetch /json/list -> Page.captureScreenshot).

## Rules of play (reasoning doctrine)
- Decide every play/discard/shop/pack/tarot by reasoning on the CURRENT observation (jokers, levels, economy, boss text, remaining hands/discards). Precompiled predictions (rchips etc.) are cross-checks, never the decider.
- Boss text governs (obs rows carry blind effect; Settled facts in RUNBOOK). No vanilla-lore assumptions (Lovers = enhancement HERE; Flint halves BASE only - GM/Splash additive ops survive). Never spend the run-saving margin: clear small blinds cheaply; every cash_out = shop scan (buy scaling/add-mult joker > pack > planet for a played family).
- One run at a time; NEVER leave a run unattended at a decision point. NO SUBAGENTS (user).

## Closed/settled (carry-forward)
- C32 doom dead; C31 parked; C28 voucher-first was driver policy (moot here; observation stands: vouchers cheap power). Moon/Sun = suit converters. Flint halves BASE. NO SUBAGENTS (user). Gates/push/WAKE_STATE discipline unchanged.
- Ops traps: overlay back inert -> CDP Escape escalation; headless Chrome drops background mouse events -> CDP clicks on 9222; killdrv.ps1 at repo root (only for driver mode); proc:// stdin TRIMS trailing newlines -> JSONL relay must be file-based.

## One exact next action
Start streak attempt #19 on White: menu turnaround `node tools/hact.mjs ctl notify_then_setup_run` -> `ctl start_setup_run` -> `ctl select_blind`, then play per playbook + t18 addendum (Half/fill engines fish big at boss blinds; joker-first a1).
