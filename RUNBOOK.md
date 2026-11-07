# Driver Runbook (poker.gl.ax Balatro automation)

Goal: win every stake (White..Gold = 8) with the Red deck. `out/wins.json` tracks wins.
Game page connects to this host over `ws://127.0.0.1:4180/` (exactly ONE browser page).

## Architecture
- `driver.mjs` - main loop: observe -> decide -> act; `--selftest` runs fixtures (always gate).
- `lib/shop.mjs` - shop policy: joker scoring + buy bar, planet/pack/joker/voucher stage order,
  needFam flip (global-led within-one), sunk-cost pack preference (`pickPack`).
- `lib/play.mjs` - hand selection, `normalizeHand` (face-down nulls -> virtual middling ranks).
- `lib/jmodel.mjs` - stateful-joker effect modeling (`knownLayer` flat/xmult/cflat layers,
  Crimson-Heart disable-lottery variants) feeding `predict()` (moved out of play.mjs 11-04).
- `lib/routes.mjs` - SHADOW multi-hand clear-P solver: Monte-Carlo play-now vs discard-now over
  unseen-deck draws; logs `route` rows, decisions untouched until the contra census justifies it.
- `lib/curve.mjs` - power-vs-required tracking: best live hand / boss target per ante (R),
  catch-up flag (R<1.1 from a3) gating surplus-money spending, `r4` snapshot on every digest.
- `lib/strategy.mjs` - family/focal logic, `PLANET_GRIND`, joker-name -> family map.
- `lib/jokers.mjs` - `JUNK_JOKER`, `STRONG_JOKER`, `jokerTier`, `classifyJoker`, `jokerOrder`.
- `lib/knowledge.mjs` - append-only `jw()` event log (ts+rid stamped centrally), run/policy state files
  (wins/stake maps, `policy.json` knobs editable without restart), `buildFamilies`, joker learned-factor store.
- `lib/reps.mjs` - blind-repeat counters (Card Sharp X3) + run-seen tracker (Blue unseen pricing) state island.
- `lib/link.mjs` - host spawn + reaps `automation-host.mjs` on exit (orphan host holds port 4180
  and request-id receipts -> `request_conflict` FATAL loop without reaping).
- Supervisor: `tmp/loopdrv.sh` runs as a NAMED service (`loopdrv<N>`, generation-incremented;
  ready-gate on port 4180) that survives driver kills and restarts `driver.mjs` with fresh
  code; `killdrv.ps1` kills driver+automation-host ONLY - the bash loop survives by design.
  PITFALL (11-04): the supervisor service can itself die (job reaping) - killdrv then leaves
  NOTHING running while :4180 may still LISTEN from a stale driver. Deploy truth: code-live =
  a `sessionstart` row with ts > commit ts; a listening port proves NOTHING about restarts.
  LIVENESS triage (11-06, 2.7h play-dead): port LISTEN + connected page + live driver can still
  mean ZERO play - an inert overlay back button deadlocked the decision loop while everything
  "healthy" watched. The only liveness proof is FRESH TELEMETRY: age of last `decide`/`runend`
  < ~10 min (a stuck-sleep ladder shows as repeating `overlay: escape`/`stuck 8x` lines in
  out/drv-stdout.txt; driver.mjs now escalates inert backs via nudgeUnpause CDP Escape).
  Exactly ONE supervisor loop and ONE watcher may exist at a time; `tmp/psloopkill.ps1` is the
  escalation if the bash loop itself must die; `powershell -File tmp/ptree.ps1` lists the whole
  chain (supervisor/driver/host/watcher) for the single-owner check.

## Reasoning-driven mode (hand-driven play; primary since 2026-11-06)
The agent plays every hand itself; no driver, no loopdrv, no wake-loop, no pinger.
- **Start:** Chrome headless must already run (Stack recovery, CDP :9222). Then start the host as a
  NAMED SERVICE (generation-incremented name, `host<N>`; last = `host12`), cwd repo root:
  `tail -F -n0 out/hostcmd.json | node automation-host.mjs --origin https://poker.gl.ax --stay-open | tee -a out/hostresp.log`
  ready-gate: log regex `listening` + port 4180. **File relay is REQUIRED** — writing ops to
  `proc://<svc>` stdin TRIMS trailing newlines, so the JSONL stream wedges (burned 11-06). The page
  reconnects on its own; proof = `{"v":1,"event":"connected",...}` line in `out/hostresp.log`.
- **Drive:** `node tools/hact.mjs <cmd>` (cwd repo root; auto fresh epoch + one stale-retry):
  `obs` = compact full view (hand/ids/shop/pack/jokers/levels/controls/phase/target);
  `act '<json>'` = any act op, e.g. `act '{"action":"buy","target":10}'`,
  `act '{"action":"use","target":8}'`, `act '{"action":"use","target":17,"select":[7]}'`;
  `play <ids>` / `discard <ids>` (comma list; selects then activates the enabled control);
  `ctl <kind>` = activate enabled control by kind (cash_out, toggle_shop, select_blind, reroll_shop,
  sort_hand_value, notify_then_setup_run, start_setup_run - run-end menu turnaround ~6 s:
  notify_then_setup_run -> start_setup_run -> select_blind). Raw ops if hact dies: append one JSON
  line `{"v":1,"id":N,"op":"observe"}` to `out/hostcmd.json` with bash printf (cwd repo root!), read
  replies from `out/hostresp.log` newest-first; parse with `node -e` + `require('fs')` - dynamic
  `import('node:fs')` inside `node -e` can die SILENTLY (observed 11-07).
- **Id/action rules:** ids are observation-local and shift on EVERY mutation (buy, joker sell, pack
  open) - rescan (`obs`) immediately before EVERY act, read ids not positions. Card tokens translate
  LITERALLY before any line-building: `10D` = Ten of Diamonds (NOT a spade-ish token), `S/H/C/D` =
  spade/heart/club/diamond - t19 died at a1 BB scoring J-high because a `10D` was eyeballed out of a
  dealt 7-J straight. Booster packs: the
  shop action is `use` (buys+opens in one, money spent), not `buy`; picking inside a pack = `use` on
  the pack-card id. Target-gated tarots (Lovers confirmed = card ENHANCEMENT in this build) accept
  `{"action":"use","target":<consId>,"select":[<cardId>]}` - may print invalid_action yet APPLY;
  verify by re-observation, never by the error string. Tower-in-hand use = no-op (unsettled gate).
- **Stop:** `write proc://<name>/kill` on the host service FIRST, then start loopdrv if returning to
  supervised mode — the host holds port 4180 while alive and loopdrv would ready-storm behind it.
- **Records:** reasoning runs do NOT write `log.jsonl` (that is driver telemetry). Outcomes go to
  `WAKE_STATE.md` (streak counter) + one numbered line per attempt in the current
  `status-YYYY-MM-DD.md` (commit per attempt, Conventional `docs(streak):`). Streak = 3 consecutive
  wins on the same stake to advance; any loss/abort/crash resets it. wins.json must mirror the GAME
  SAVE unlocks (game save is authority). CDP :9222 (clicks, screenshots) is independent and stays up
  in both modes.
- **Cadence (attempt 18 doctrine, 11-07):** ONE hact call per decision; `obs` immediately before
  EVERY play/discard - stale ids can make a discard DRAW IDENTITY cards (the hand comes back
  byte-identical and discards stay unspent - burned twice, attempt 18; detect it: hand + discards
  count unchanged after discard, then rescan and retry). Per-blind plan arithmetic:
  need = (target − score) / hands_left vs known lines (below); fill cheap on small blinds, keep
  the big fish + discards for bosses. `ctl cash_out` ends every blind (phase `cash_out` -> shop).
  The page idles INDEFINITELY at menu/shop/pack phases - no timer - so a live run can survive a
  context compaction mid-shop; to stay resumable from a bare notebook, refresh `WAKE_STATE.md`
  streak line + the session notebook at every blind-end/ante boundary and immediately on death/win
  (attempt state: jokers, levels, deck mods, money, what the next blind demands).
- **Engine lines measured hand-played (attempt 18, Half Joker + Credit Card + Joker Stencil,
  no other triggers):** Half pair+kicker 3-card line = (10 + pair chips + kicker) x ~35
  = 660-1150/hand and is the a1-a4 blind-filler; it did NOT scale with discards left (30x35 at
  d4 == d0 - Swashbuckler "+2 mult per discard" unproven, retest while actually holding one).
  Burst: 3-discard fish at a 4-run/4-flush ≈ 25-40%, straight/flush L1 line ≈ 2600-2900;
  FH fish from two-pair keepers is THE a4+ power play (observed FH 107chips x 38 = 4095; FH
  levels from Earth/Venus-class planets double its base). a4 bosses (4000-5000) fell to Half
  fills + one FH; T2/house lines 44-62chips x15-17 = dead weight vs those targets.

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
5. After EVERY code commit, `git show --stat` and read the FILE NAMES against what you edited -
   a matching insertion COUNT is not proof (COHORT-19b incident: shop.mjs hunk of a 3-file edit
   silently stayed out of the commit; the working tree still ran it so cohorts measured code that
   git never recorded, and a later rebase dropped it wholesale). Commit message naming a behavior
   it does not contain is the failure mode; grep the tag string (`git log -S`) to settle existence.

## Stack recovery (crash at menu / game_unavailable)
`tmp/psloopkill.ps1` -> `killdrv.ps1`; reload the game page (Chrome app-mode, CDP 9222, profile
`chrome-profile`, cold start ~100s), `tmp/click.mjs 452 792`, `tmp/startws.mjs` (needs 4180 free),
`Start-Process loopdrv.sh` (or the named-service launch used since 11-04, ready-gate port 4180). Menu `setup_run` WS
activate NO LONGER crashes the page (10-30 fix; driver self-serves New Run -> PLAY in ~5 s); New Run overlay cycling is
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
  (11-04 TRAP: from a bash/service context bare `chrome.exe` is NOT on PATH - Start-Process
  silently no-ops with zero output; ALWAYS use the full path
  'C:\Program Files\Google\Chrome\Application\chrome.exe'. The chrome-game service died with
  exit 127 = exactly this; the whole reboot storm was a silent no-chrome loop)
  `--headless=new --app=https://poker.gl.ax/ --remote-debugging-port=9222
  --user-data-dir=D:\balatro-ai\chrome-profile --no-first-run --no-default-browser-check
  --window-size=1953,1616 --force-device-scale-factor=1.5 --enable-unsafe-swiftshader
  --disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows`
  (last three flags 11-05 PROGRESS-LOSS FIX: the site batches love-fs save writes with a 30s
  checkpoint + server admit; background/occluded timer throttling stretches that window,
  widening what a crash or reload can roll back - keep the flush clock running at full rate;
  verified boot: visibilityState=visible, 20/20 GPU pipelines, game mounts; keep window-size/dpr
  so the css-px click mapping in the RUNBOOK notes stays valid; audio stays silent - no gesture -
  automation doesn't care). observe() patient-waits hidden pages since e3c1cd9; with headless the
  patient path should be RARE - if it re-cycles >2x, the page died, relaunch per above.

## Fully-unlocked profile (11-04 USER did Unlock All - DO NOT LOSE)
- Collection = Jokers 150/150, Decks 15/15, Vouchers 32/32, Planets 12/12, Blinds 30/30,
  Tarots/Spectrals/Tags/Booster/Editions complete. Unlocks live in the GAME PROFILE
  (profile.jkr via batched love-fs -> IndexedDB leveldb WAL); the button is Main Menu ->
  COLLECTION -> Unlock All (mid-run options-overlay Collection LACKS it; cost = profile
  achievements disabled, irrelevant).
- BACKUP (post clean Browser.close, chrome stopped): D:\balatro-ai\chrome-profile-backups\
  unlocked-20261104T2038\ {IndexedDB, Local Storage, Session Storage}. RESTORE with driver+
  chrome stopped: `powershell -File tmp/restore-unlocked.ps1` (aborts if our profile instance
  runs; match it with tmp/killprof.ps1 - NEVER taskkill through bash //PID (silent no-op)).
- VERIFY any save-changing op: CDP freeze (setWebLifecycleState frozen 3s -> active) then
  ~35s checkpoint wait, then Browser.close (CLEAN - service kill loses pending batch).
  Persistence test after reopen: menu -> COLLECTION -> counts (tmp/verifyunlocked.mjs-ish;
  menu row kind your_collection; overlay hub has NO collection row at menu level).
- HEADED windows for user interaction: launch same RUNBOOK flags MINUS --headless=new;
  a SECOND instance with the same --user-data-dir forwards + exits 0 (no port!). Sequence:
  killprof.ps1 -> REMAIN 0 -> launch. After user work, restore headless flags.

## Log forensics (out/log.jsonl, out/digests.jsonl)

- LEGACY ROW TRAP (found 11-04 via 234 phantom planet-uses): old log.jsonl rows carry NO `ts`
  field - `undefined < since` is FALSE, so raw scans MUST use the positive test `r.ts >= eraTs`
  (or go through runs.db where NULL ts fails SQL comparisons). Any `r.ts < since -> continue`
  silently mixes the whole month-old corpus into era censuses.
- `node tools/dbimport.mjs` maintains `out/runs.db` (node:sqlite, derived - delete freely): INCREMENTAL
  SCHEMA GOTCHA: rundigest's clock column is `t` (digest rows carry `t`); every other table uses `ts`.
  Unknown event types (incl `curve`) land in `other(ts,rid,e,body)` with the row JSON in body.
  GitHub pushes from the bot hit TRANSIENT 403s occasionally - plain retry usually lands.
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
- 11-04 rows/columns: `route` shadow rows {a, ante, boss?, pNow, pDisc, rem, hl, dl} (tools/route.mjs
  = disagreement census; switch the decision only when contra rows cluster at a4+/boss with real
  ΔP; CLOSED 11-04: 348 rows 0% contra, kept as canary); `rundigest.r4` = power ratio at the a4
  boss-select (era KPI: corpus baseline ~36% of a4-reached runs arrive with R>=1). SURVIVORSHIP:
  r4 covers only the 74% that reach a4 boss-select (n=1306 corpus: 26% die PRE-boss at a4 SB/BB,
  33% at the boss, 36% pass it) - the `curve` rows (r/r4/catchup per blind-select) see all of it;
  feed = post-score blind totals (2cf40ea; pre-play feeds read 0 on single-hand blinds);
  turn `dl` = DISCARDS left (was a hands_left copy-paste
  before 11-04 - pre-11-04 dl rows are not discard data).
- Analysis tools live in `tools/` (COMMITTED, linted): `watchrun` (wake-on-digest, incremental),
  `wake.mjs` (one-shot wake: dbimport + era tallies where era boundaries are CODE changes only -
  every push incl docs restarts the driver and writes a deploy row that is NOT a measurement
  boundary - plus watch counters; last stdout line = newest digest ts so a wake is
  `T=$(node tools/wake.mjs | tail -1) && WATCH_N=4 node tools/watchrun.mjs "$T"`; the watcher
  dies with its parent chain after firing - ALWAYS rearm inside the wake call),
  `dbimport`+`cohort` (db + epoch readout; `cohort --verdict <sha> [--base <sha>]` = the standing
  pre-registered verdict table for a deploy window), `avail`+`supply` (shelf/pool availability
  censuses: focal-on-shelf misses are the ONLY real targeting signal; fillers are supply-forced
  by design), `copiers` (copier-joker sell/buy gates), `deepx` (pred-vs-actual by joker),
  `vouchers` (voucher-offer census), `extract_jokers` (truth-blob extraction), `vp` (click-px
  mapper), `ordplay` (order replay harness), `route` (shadow clear-P contra census:
  `node tools/route.mjs <since-ts>` prints per-band disagreement/tie rates), `curve`
  (`node tools/curve.mjs <since> [until]` = COHORT-19b verdict: catchup fire-rate from e='curve'
  mechanism rows, a4 pre-boss/boss/pass attrition vs 26/33/36 corpus baseline, avgA).
  Cohort-concluded one-shot probes (bosscal, votes, surgeclass, ledcheck, plmatch, planleak,
  depthan, enhcens, intcensus2, jkgap, focvis; ~850 lines) were DELETED 11-04 - promote back
  from git history when their question is re-opened. `tmp/` (gitignored) keeps ops scaffolding
  (`loopdrv.sh`, `pslist.ps1`, `psfull.ps1`, `psloopkill.ps1`, `killprof.ps1`, `ptree.ps1`,
  `raise-chrome.ps1`, `restore-chrome.ps1`, `restore-unlocked.ps1`, `click`, `startws`,
  `menudump/unlockall/verifyunlocked/optsurvey/optdeep` menu ops) plus live audit tools
  (`auditdocs`, `exportscan`) and throwaway probes - probes must pass the lint gate the day
  they are written and get deleted when their question closes.

## Settled build facts (verified; do not re-litigate)
- Effect texts: `blind` rows carry the boss effect verbatim (all 26 bosses seen in log = match
  doctrine); pack/shop ITEM rows carry `effect:""` ALWAYS (bridge strips it) - joker/tarot text
  is oracle-only, never re-mine the log for it (11-01 census: 0/7262 item rows had text).
- Focal scatter is STRUCTURAL, not a targeting bug (11-04, n=110 deaths + 9/9 late-flip audit):
  61% of banked levels sit off-focal at death and the last a4+ needFam flip lands on the final
  play-max family EVERY time - a flipped run arrives new-family L1 because a visit buys one
  planet and flip costs bank the old family. Do not "fix" targeting to chase lvlMap scatter;
  the deep wall is multiplier/pricing (jokers), bounded by this: no targeting change closes it.
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
  was fiction. Now use-on-sight (PASS @n20: starved 39->20%).
- TAROT CLASS FACT (11-04 buy-vs-use census, whole db): only High Priestess/Emperor/Judgement/
  Hermit/Wheel ever fire (90%+ use rates); the ENTIRE card-target class (Magician/Chariot/Justice/
  Strength/Devil/Tower/Hanged/Death/Empress/Hierophant) plus select-gated planet suits (Moon/Sun/
  Star/World) plus Fool/Temperance/Ankh/Lovers sit at 0 uses across ~1,400 purchases - Lovers even
  logged action_unavailable x31. Shop+pack buys are WHITELISTED to the five live names (COHORT-18);
  target-class rules in tarot.mjs/strategy.mjs idle harmlessly until oracle texts unlock them.
- SCALING LAW (11-04, n=6915 ante-rows): boss targets scale a FIXED curve 2.50x/ante through a4,
  then 2.20/1.82/1.75/1.43 - purchases are priced against THAT. Power ratio R=best live hand/boss-target
  predicts failure only from a4 (R<1 -> 31% reach a5, R>=1 -> 91%, R>=2 -> 15% a7 / 7.7% win); at a2-a3
  every observable bucket lands P(a5+) 16-31% = noise -> NO mid-run abandonment (study closed
  11-04; wins/hr is ticket-volume-bound, next-run auto-start ~5s). R MIS-PREDICTS boss EFFECTS
  (11-04 deaths): it is a blind-total vs target ratio - The Needle (play only 1 hand) killed an
  R=2.23 run, The House (first hand face down) killed R=1.09; boss effect text rides every blind row
  (`boss.effect`), so hand-limited/face-down bosses can force catchup WITHOUT oracle input.
- Game save may silently FAIL to record a won stake (Red won 10-31, wins.json has it, setup
  rows stayed 2-unlocked): `out/game-stake-cap.txt` mirrors game truth; a stake win must be
  REPEATED game-side before the ladder advances. Never conclude Green-locked is a bug from
  wins.json alone.
- REASONING-ERA DIRECT OBSERVATIONS (11-06/07, hand-played): the card-target tarot class IS
  usable over the relay via `use` + `"select":[cardId]` (Lovers enhanced the selection into a
  Glass Card; its reply printed invalid_action yet APPLIED - the driver-era "0 uses /
  action_unavailable" census reflected the DRIVER op shape, not a game gate). Lovers = card
  ENHANCEMENT here, not vanilla copy-joker. Hermit DOUBLES money (observed 4->8; $3 item =
  outright profit below 2x money). Suit-debuff bosses (Head/Goad): debuffed cards score 0 chips
  but hand SHAPE and hand BASE still score (all-spade debuffed flush scored 140). Booster shop
  items take `use` (buys+opens, money spent); pick inside a pack = `use` on a FRESH-scanned
  pack-card id (stale id = action_unavailable).
- HELD-CARD ECONOMY + PACK PICKABILITY (11-07, attempt 14 to a5 boss): Standard/Celestial pack
  picks are relay-pickable (`use` on fresh id) and strong - Stone +50 chips HELD (never PLAY it,
  played stone scores ~0), Steel x1.5 mult HELD, Glass x2 mult PLAYED (1/4 destroy). OPEN
  CONTRADICTION (11-07 attempt 18): a Stone WAS bought as a Standard pick expecting +50 chips IN
  the played Half line; if played stone truly scores ~0 Stone picks are economy-dead - attempt 18
  is the live test, do not buy another before it settles. BUT inside
  Arcana/Jumbo-Arcana packs, every target-gated tarot (Lovers/Devil/Chariot/Star...) shows
  inspect-only and `use` = action_unavailable = UNPICKABLE (money lost; in-HAND use+select still
  works, see prior bullet - the gate is pack-time selection). Judgement/planets/Fool-type = fine.
  Smiley Face pays per face CARD played (>=2 face cards fire; repeating the same face RANK within
  one blind pays progressively less - spread ranks across hands). Chad = +mult per hand remaining,
  Swashbuckler = +2 mult per discard HELD (save the last discard for the scoring hand). Fish draws
  literally show `undefined` in obs (unknown ranks, NOT stones); The Wheel shows faces normally.
- ENGINE TRIGGERS + LOCKS (11-07, attempt 16 to a6 BB, verified in live scoring): Half Joker fires
  when <=3 cards are PLAYED (not "counted") - pair+1 3-card line = +20 mult fill-line ~900-1700/hand
  with no other trigger. THE MOUTH locks the played hand TYPE exactly: High Card lock then Full
  House = scores 0 (tested live; do not "try" out-of-family big hands, they are wasted hands).
  Lock the family whose sustainable ceiling >= target/hands: vs 5k+/hand only FH/quads class works,
  which requires trips+pair in the FIRST dealt hand - else take Straight (~2.5-3.7k fish) and
  accept Mouth is the run-ender at that level. Planet packs: display names SHIFT family per
  build-run (same run: Saturn applied Straight, Pluto applied High Card) - READ the `levels` reply
  after every planet use, never assume from the pack row name. Shop jokers tagged (x) are UNBUYABLE
  when joker slots are full (use=action_unavailable); packs tagged (x) still open and pay out fine.
- pickRule matches `"key name"` strings - anchored ^ regexes can never match consumable
  names; consumable rules live in strategy.mjs TAROT_RULES (allowlist semantics: unknown
  names never used).

## Stake progression vs mastery (standing rule; full text in AGENTS.md)

1 win = PROGRESSION (unlocks next stake). MASTERY/ADVANCEMENT (USER 2026-11-06) = **3 CONSECUTIVE
wins on the same stake**, no loss between; any loss/crash/abort resets the streak to 0.
(Supersedes the old >=9-in-30 rule.) Attempts must be real completed-or-failed runs; never
drop a failure from the sequence. Tag every streak attempt with mode (reasoning-driven vs
driver), stake, and outcome in the status log. Standing: White 0/3; ALL higher stakes are
LOCKED in the game save (the 11-06 reboot wiped unlocks; `out/wins.json` = `{}` mirrors it -
game save is authority, see Settled facts) and are re-earned by progression wins.

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
