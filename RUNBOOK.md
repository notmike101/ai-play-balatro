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
4. `node tmp/watchrun.mjs <T0>` as its OWN async bash job, timeout 3500 (chaining inherits a short
   timeout and dies silently). Dedup by T0.

## Stack recovery (crash at menu / game_unavailable)
`tmp/psloopkill.ps1` -> `killdrv.ps1`; reload the game page (Chrome app-mode, CDP 9222, profile
`chrome-profile`, cold start ~100s), `tmp/click.mjs 452 792`, `tmp/startws.mjs` (needs 4180 free),
`Start-Process loopdrv.sh`. Menu `setup_run` click CRASHES the page; New Run overlay cycling is
1-BASED index (auto-detected).

## Log forensics (out/log.jsonl, out/digests.jsonl)
- Item rows use SHORT keys `k/n/c/a` (kind/name/cost/actions) in packdump; shopdump uses
  kind/name in this build era - ALWAYS print one raw sample row before writing a census
  (`i.kind` on packdump silently matched nothing and inverted a whole analysis once).
- `decide` rows: pred/rchips logged BEFORE the play; actual = rchips delta between consecutive
  same-blind rows (`tmp/bosscal.mjs` join). rchips deltas across bank resync are contaminated.
- `rundigest` focalLvl/LOW_FOCAL LIE on The Arm endings (post-play level decrement; add +1).
- CELESTIAL take = INSTANT level. Cards serialize positionally `[idx,rank,suit,sel,"",""]`;
  enhancements/seals invisible to bridge -> predictions undercount enhanced hands (conservative).
- Evidence of targeted tarot execution = `tarottarget`/`consuse` rows with `ok:true`.
- Tools in `tmp/` (gitignored; lint manually): `watchrun` (wake-on-digest), `bosscal` (per-boss
  pred calibration), `surgeclass` (death classification), `ledcheck`, `plmatch` (take-vs-nf match:
  focal-on-shelf misses are the ONLY real targeting signal; fillers are supply-forced by design),
  `planleak`, `depthan`, `deepshop <rid>`, `click`, `startws`, `psloopkill`.

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

## Strategy state (2026-10-29)
Leveling policy works end-to-end: deepest losses now a8 CHIP_GAP at Pair-L11 - levels are supply-
capped (Mercury ~35% of packs, fair per-planet), remaining gap = xmult joker depth at a6+ (100k
needs ~25k/hand). Do NOT tighten FOCAL-FIRST ordering (0/11 focal-on-shelf misses); filler takes
are supply-forced. Band/meta tunes (want thinning, a5 floor, fp bar) are gated until the FIRST
win to avoid fitting noise on all-dead distributions.
