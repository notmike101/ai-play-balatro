# Driver Runbook (poker.gl.ax Balatro automation)

Goal: win every stake (White..Gold = 8) with the Red deck. `out/wins.json` tracks wins.
Game page connects to this host over `ws://127.0.0.1:4180/` (exactly ONE browser page).

## Architecture
- `driver.mjs` - main loop: observe -> decide -> act; `--selftest` runs fixtures (always gate).
- `lib/shop.mjs` - shop policy: joker scoring + buy bar, planet/pack/joker/voucher stage order,
  needFam flip (global-led within-one), sunk-cost pack preference (`pickPack`).
- `lib/play.mjs` - hand selection, `normalizeHand` (face-down nulls -> virtual middling ranks).
- `lib/strategy.mjs` - family/focal logic, `PLANET_GRIND`, joker-name -> family map.
- `lib/knowledge.mjs` - `JUNK_JOKER`, `STRONG_JOKER`, `jokerTier`, policy constants.
- `lib/link.mjs` - host spawn + reaps `automation-host.mjs` on exit (orphan host holds port 4180
  and request-id receipts -> `request_conflict` FATAL loop without reaping).
- Supervisor: `loopdrv.sh` restarts `driver.mjs`; `killdrv.ps1` kills driver+host+loop.
  Exactly ONE supervisor loop and ONE watcher may exist at a time.

## Deploy
1. `node driver.mjs --selftest` must print `SELFTEST OK`.
2. `pnpm exec eslint --fix <files>` then `pnpm run lint > out/lint.txt`; verify `echo $?` prints 0
   BEFORE commit (a bare `echo` after `;` never gates - burned twice).
3. `powershell -File killdrv.ps1` (mid-run is fine; supervisor restarts). Watchers are bash jobs -
   kill the old one before arming a replacement (double-fired once).
4. `node tools/watchrun.mjs <T0>` as its OWN async bash job, timeout 3500 (chaining inherits a short
   timeout and dies silently). Dedup by T0.

## Stack recovery (crash at menu / game_unavailable)
`tmp/psloopkill.ps1` -> `killdrv.ps1`; reload the game page (Chrome app-mode, CDP 9222, profile
`chrome-profile`, cold start ~100s), `tmp/click.mjs 452 792`, `tmp/startws.mjs` (needs 4180 free),
`Start-Process loopdrv.sh`. Menu `setup_run` click CRASHES the page; New Run overlay cycling is
1-BASED index (auto-detected).
- ALWAYS send `Page.bringToFront` BEFORE `Page.reload` (10-30, three zombie loops): Chromium
  won't boot WebGPU on a hidden page -> half-booted page connects then answers
  `action_unavailable` to everything; a second/third plain reload does NOT fix it, foreground does.
  `reloadPage()` now does this; manual one-liners must too. If already zombied while foreground,
  `wakeZombie`/Escape-nudge path applies (real input; CDP keys unreliable).
- Host rotation orphans the page (connects only at load): after killing the driver WITHOUT the
  service loop, a fresh host gets the auto-reconnecting page - but if the page was mid-zombie it
  stays zombie; reload with bringToFront is the reset.

## Log forensics (out/log.jsonl, out/digests.jsonl)
- `node tools/dbimport.mjs` maintains `out/runs.db` (node:sqlite, derived - delete freely): INCREMENTAL
  (byte-offset in meta table; full rebuild if the log truncates) and stamps `deploy` rows = per-commit
  cohort epochs; `node tools/cohort.mjs [N]` prints the last N epochs' n/avgA/hist/L1-at-death/flip rows.
  One table per hot event (decide/shopdump/shopdone/packdump/gamefam/blind/rundigest/..., `other`
  for the rest; view `runmax` = per-rid depth). Census in SQL (joins beat bespoke parsers -
  a wrong mapping table inside a bespoke join once invented 39 phantom focal misses).
- Item rows use SHORT keys `k/n/c/a` (kind/name/cost/actions) in packdump; shopdump uses
  kind/name in this build era - ALWAYS print one raw sample row before writing a census
  (`i.kind` on packdump silently matched nothing and inverted a whole analysis once).
- `decide` rows: pred/rchips logged BEFORE the play; actual = rchips delta between consecutive
  same-blind rows (`tools/bosscal.mjs` join). rchips deltas across bank resync are contaminated.
- `rundigest` focalLvl/LOW_FOCAL LIE on The Arm endings (post-play level decrement; add +1).
- CELESTIAL take = INSTANT level. Cards serialize positionally `[idx,rank,suit,sel,"",""]`;
  enhancements/seals invisible to bridge -> predictions undercount enhanced hands (conservative).
- Evidence of targeted tarot execution = `tarottarget`/`consuse` rows with `ok:true`.
- 10-30 probe rows: `cashout` (reward-panel labels per blind -> interest truth), `handstab`
  (game hands table incl hidden hands, once/ante), decide `cids`/`sids` = SELECTED/scoring card
  ids (slot ids; join with the same-frame turn row for content) + `enh`/`sla` counts. Historical
  decide rows have NO played set (`t.n` never set on play returns; slot-id reuse kills
  multiset joins) - pre-10-30 corpus cannot validate per-play order effects.
- Analysis tools live in `tools/` (COMMITTED, linted): `watchrun` (wake-on-digest, incremental),
  `dbimport`+`cohort` (db + epoch readout), `bosscal` (per-boss pred calibration), `votes`
  (gamefam focal audit), `surgeclass` (death classification), `ledcheck`, `plmatch`+`avail`+`focvis`
  (take-vs-nf: focal-on-shelf misses are the ONLY real targeting signal; fillers are supply-forced
  by design), `planleak`, `depthan`, `enhcens`, `intcensus2`, `jkgap`, `bosscal`, `vp` (click-px
  mapper), `ordplay` (order replay harness). `tmp/` (gitignored) keeps ONLY ops scaffolding:
  `loopdrv.sh`, `pslist.ps1`, `psloopkill.ps1`, `click`, `startws`.

## Settled build facts (verified; do not re-litigate)
- Face-down bosses (Mark/Fish/House/Pillar...) show `rank:null` - normalize before scoring. The
  Pillar debuffs exact copies of ranks 1-6 played this ante without setting `c.debuffed`.
- `run.current_score` never updates; progress = self-banked predictions; while phase=='hand' the
  true score is target, so bank>=target with blind alive => resync bank to 0.
- Face-down honest scale: fd play EV ~0.6x raw pred (Mark .62 / Fish .56 medians) - gates AND
  bank credit use the same 0.6 factor.
- Opening a booster rerolls shop shelf slots -> pending joker buy and pack open are mutually
  exclusive; buy stages share one money pool (earlier stage must leave later item cost + floor).
- Voucher `use` action appears ONLY when money == cost. The Needle = 1 hand/1.5x money; Amber
  Acorn (a8 final, 100k) flips/shuffles Jokers.
- Booster packs may open as TOP-LEVEL phase 'pack'; Jumbo packs allow ONE pick despite "pick 2".
- Loyalty Card x5 never fires (junk). Splash: cross-suit flush claim UNVERIFIED - `mixflush`
  probe in play path settles it on first capture (ratio >= 1 fine, ~0.1 demote).
- Flint preds exact; option_cycle 1-based; post-boss phase is 'cash_out'.

## Stake progression vs mastery (standing rule; full text in AGENTS.md)

1 win = PROGRESSION (unlocks next stake). MASTERY = >=9 wins in 30 consecutive
autonomous attempts on the same stake with UNCHANGED policy+scoring; any gameplay-
affecting change resets the window. Win = Ante 8 boss defeated. Measurement recipe:
attempt = any run with a `runstart` row (losses/crashes/interrupts ALL count; a run
with runstart but no results row counts as a failed attempt — never drop it); per-
window stats = win rate, avg exit ante, duration (runstart->runend/result ts); tag
every archived window with policy version + git commit (`git rev-parse HEAD` at window
start). Never claim consistency from 1 win; no time-based quotas. Mastery is tracked
independently of progression: current standing = White progressed/not-mastered (policy
changed post-win, window re-based), Red grinding 0 wins.

## Strategy state (2026-10-29)
Leveling policy works end-to-end: deepest losses now a8 CHIP_GAP at Pair-L11 - levels are supply-
capped (Mercury ~35% of packs, fair per-planet), remaining gap = xmult joker depth at a6+ (100k
needs ~25k/hand). Do NOT tighten FOCAL-FIRST ordering (0/11 focal-on-shelf misses); filler takes
are supply-forced. Band/meta tunes (want thinning, a5 floor, fp bar) are gated until the FIRST
win to avoid fitting noise on all-dead distributions.
