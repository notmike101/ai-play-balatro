# Driver Runbook (poker.gl.ax Balatro automation)

Goal: win every stake (White..Gold = 8) with the Red deck. `out/wins.json` tracks wins.
Game page connects to this host over `ws://127.0.0.1:4180/` (exactly ONE browser page).

## Architecture
- `driver.mjs` - main loop: observe -> decide -> act; `--selftest` runs fixtures (always gate).
- `lib/shop.mjs` - shop policy: joker scoring + buy bar, planet/pack/joker/voucher stage order,
  needFam flip (global-led within-one), sunk-cost pack preference (`pickPack`).
- `lib/play.mjs` - hand selection, `normalizeHand` (face-down nulls -> virtual middling ranks).
- `lib/strategy.mjs` - family/focal logic, `PLANET_GRIND`, joker-name -> family map.
- `lib/jokers.mjs` - `JUNK_JOKER`, `STRONG_JOKER`, `jokerTier`, `classifyJoker`, `jokerOrder`.
- `lib/knowledge.mjs` - append-only `jw()` event log (ts+rid stamped centrally), run/policy state files
  (wins/stake maps, `policy.json` knobs editable without restart), `buildFamilies`, joker learned-factor store.
- `lib/reps.mjs` - blind-repeat counters (Card Sharp X3) + run-seen tracker (Blue unseen pricing) state island.
- `lib/link.mjs` - host spawn + reaps `automation-host.mjs` on exit (orphan host holds port 4180
  and request-id receipts -> `request_conflict` FATAL loop without reaping).
- Supervisor: `loopdrv.sh` runs as a persistent proc SERVICE (`proc://loopdrv`, survives driver
  kills and restarts `driver.mjs` with fresh code); `killdrv.ps1` kills driver+automation-host
  ONLY - the bash loop survives by design. Exactly ONE supervisor loop and ONE watcher may exist
  at a time; `tmp/psloopkill.ps1` is the escalation if the bash loop itself must die.

## Deploy
1. `node driver.mjs --selftest` must print `SELFTEST OK`.
2. `pnpm exec eslint --fix <files>` then `pnpm run lint > out/lint.txt`; verify `echo $?` prints 0
   BEFORE commit (a bare `echo` after `;` never gates - burned twice).
3. `git push` commits the code; the WORKING TREE IS THE DEPLOY (same checkout, no git pull
   anywhere - verified: no hooks, loopdrv has no fetch). The running driver keeps its loaded
   code until it exits; loopdrv then restarts it with fresh code. Pushed changes are live ONLY
   after a restart: they usually appear within minutes because the page reconnect cycle can
   kill the driver, but NEVER assume it - after a lib/ change, force it via CIM Stop-Process of
   the driver/host PIDs (NOT the bash loop), sleep 18, verify tmp/pslist.ps1. Verify a new
   `deploy` row at/after your push ts - BUT KNOW WHAT IT IS: dbimport SYNTHESIZES deploy rows
   from git commit times, so deploy.ts ~= commit ts ALWAYS, restart or not. Actual code-live
   proof = a `sessionstart` log row at ts >= your commit (driver boots from the working tree;
   a driver mid-exit can take minutes - the page reconnect cycle), and remember an early boot
   from the same tree already runs your code (15b proof: sessionstart 14s BEFORE the commit).
   wake.mjs era rows show code-change boundaries only; a docs-commit deploy row is not an era.
4. Watchers are bash jobs chained INSIDE the wake call (`wake.mjs | tail -1` pattern above);
   kill the previous watcher job before arming a replacement (double-fired once).

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
- USER KEEPS THE MONITOR (10-31, THE FINALS exclusive-fullscreen): an occluded windowed Chrome can
  NEVER show the tab (bringToFront/ShowWindow/TOPMOST all lose to exclusive fullscreen) and the game
  shell refuses to boot hidden ("waiting for visible tab"). Doctrine = run Chrome HEADLESS:
  `Stop-Process` the `--app=` chrome main PID, then Start-Process chrome.exe with
  `--headless=new --app=https://poker.gl.ax/ --remote-debugging-port=9222
  --user-data-dir=D:\balatro-ai\chrome-profile --no-first-run --no-default-browser-check
  --window-size=1953,1616 --force-device-scale-factor=1.5 --enable-unsafe-swiftshader`
  (verified boot: visibilityState=visible, 20/20 GPU pipelines, game mounts; keep window-size/dpr
  so the css-px click mapping in the RUNBOOK notes stays valid; audio stays silent - no gesture -
  automation doesn't care). observe() patient-waits hidden pages since e3c1cd9; with headless the
  patient path should be RARE - if it re-cycles >2x, the page died, relaunch per above.

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
  `wake.mjs` (one-shot wake: dbimport + era tallies where era boundaries are CODE changes only -
  every push incl docs restarts the driver and writes a deploy row that is NOT a measurement
  boundary - plus watch counters; last stdout line = newest digest ts so a wake is
  `T=$(node tools/wake.mjs | tail -1) && WATCH_N=4 node tools/watchrun.mjs "$T"`; the watcher
  dies with its parent chain after firing - ALWAYS rearm inside the wake call),
  `dbimport`+`cohort` (db + epoch readout; `cohort --verdict <sha> [--base <sha>]` = the standing
  pre-registered verdict table for a deploy window), `bosscal` (per-boss pred calibration), `votes`
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
- Loyalty Card x4 every 6th hand and DOES fire (oracle 10-29; old "never fires" line wrong).
  Splash = every played card scores (seals/enhancements/jokers trigger); NOT a cross-suit
  flush wildcard (oracle 10-29). Obelisk = X0.2 per hand that is NOT the most-played family,
  resets to X1 when the most-played family is played -> permanently X1 (junk) for our
  single-family grinds.
- Flint preds exact; option_cycle 1-based; post-boss phase is 'cash_out'.
- CELESTIAL PACK pool contains Black Hole (spectral): `take:Black Hole` from a celestial
  pack applies INSTANTLY (+1 level EVERY family - the "every-family-L2" lvlMap signature).
  scorePackOffer ranks it 32 > focal planet 30 -> correct pick (focal gets its +1 + 8 free).
- Planets were NEVER consumed in engine history until 11-01 (6c58e03): shop `buy_and_use`
  applies instantly, but bare-`buy` and Priestess/Emperor-created planets rotted in slots -
  the use-allowlist had no planet rule and the doc claiming "driver plays planets per-hand"
  was fiction. Now use-on-sight (PASS @n20: starved 39->20%). Money/utility tarots without
  rules (The Moon, Strength, Hierophant, Hanged Man) STILL rot pending oracle texts.
- Game save may silently FAIL to record a won stake (Red won 10-31, wins.json has it, setup
  rows stayed 2-unlocked): `out/game-stake-cap.txt` mirrors game truth; a stake win must be
  REPEATED game-side before the ladder advances. Never conclude Green-locked is a bug from
  wins.json alone.
- pickRule matches `"key name"` strings - anchored ^ regexes can never match consumable
  names; consumable rules live in strategy.mjs TAROT_RULES (allowlist semantics: unknown
  names never used).

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

## Strategy state (2026-10-31 baseline; 11-01 chain in status-2026-11-01.md at repo root)
11-01 update: cohort chain 14 draw-EV discards (PASS, avgA 3.20) + 15b planet use-on-sight
(PASS, starved 39->20%, avgA 3.40) live; a5+ deaths now dominated by CHIP_GAP depth at
focalLvl ~2 (levels ceiling; supply drought ~20%). Status files live at REPO ROOT
(`status-YYYY-MM-DD.md`) - the old "reports/" path never existed.
Three wins recorded (2 game-side: White a8-era + Red economy-proven BUT game-save
unregistered - see Settled facts; ladder clamps to setup-row unlocked count). Current era runs RED stake; death taxonomy (all measured, cohort chain in the
report): (1) STARVED a1-3 ~30-50% of runs — zero levels bought: planet/pack supply drought.
Reroll lottery is dead for PLANETS (0/25 shelf-planet hits, 10-31) — do not re-add planet hunt
priority. Do NOT extend that to jokers/vouchers: 11-01 census n=37 reroll-shops, 62% bought a
joker/voucher/pack right after the last reroll ($310 era spend). Causation UNPROVEN (buy-after
!= buy-because-of-refresh; needs shelf-content diff) - keep reroll policy as-is, don't kill or
boost it off either note.
The stock supply counter (Planet Merchant/Telescope) sat UNBOUGHT due to a keepFloor deadlock,
fixed 29ed298 (hold floor must be exempt from its own item's buy floor — reusable pattern).
(2) NF-CHURN spread — levels scattered 3+ ways at focalLvl<=1; cohort-11 stickiness (>=6 plays
& >=2 lvl holds, challenger needs +2) is the live counter. (3) a5+ CHIP_GAP = xmult joker depth
(Brainstorm/Blueprint never bought yet; corpus wins all ran single-focal L7-11 boards).
Still settled from 10-29: do NOT tighten FOCAL-FIRST ordering (0/11 focal-on-shelf misses,
filler takes supply-forced); Mercury fair (~35% of packs, uniform per-planet); digest snapshots
post-effect can lie (Arm decrements AFTER scoring); a low action-vs-target match rate is only
actionable after an availability join. Band/meta noise-tunes stay gated until cohort verdicts,
one lever per window, telemetry-or-revert on every new gate.
