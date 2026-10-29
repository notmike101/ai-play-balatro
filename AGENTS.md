# AGENTS.md

Autonomous Balatro (poker.gl.ax web build) player: `driver.mjs` observes/acts over a
WebSocket bridge and grinds the stake ladder unattended.

## Layout

- `driver.mjs` — decision loop + shop/pack/overlay/setup policy (state: per-blind bank,
  per-ante played ranks, strategy focus). Phase-driven: `observe()` -> act on controls.
- `lib/link.mjs` — bridge host lifecycle (spawns `automation-host.mjs`, ws://127.0.0.1:4180),
  `observe/act`, CDP recovery helpers (`reloadPage`, `nudgeUnpause` over loopback :9222).
- `lib/acts.mjs` — act primitives: highlight play/discard with direct-verb fallback,
  targeted-tarot select-then-use, joker-lineup sync, deck probe (once per run).
- `lib/playturn.mjs` — hand-phase engine: `playTurn` (which hand to play vs discard,
  incl the stake-2 one-discard desperation cap and boss handling for Mouth/Eye/Pillar/
  face-down scaling) and `handleHand` (the whole turn pipeline: blind-bank sync, planet/
  tarot prep, telemetry `turn`/`decide` rows, calibration, zombie-pause recovery).
- `lib/play.mjs` hand-eval + per-hand prediction/calibration; `lib/strategy.mjs` family
  focus, joker tiers, pack/tarot scoring; `lib/shop.mjs` shop/pack buying;
  `lib/digest.mjs` pure per-run digest rollup + accumulator reset;
  `lib/knowledge.mjs` durable state under `out/` (log, results, digests, wins, stake locks,
  `policy.json`).
- `tests/` assertion suite, run via `node driver.mjs --selftest`: `selftest.mjs` is a
  19-line runner chaining six topic modules (`handfams`, `lineup`, `calibration`,
  `policy`, `jokerefx`, `digest`); shared fixtures (cards, tables, contexts) live in
  `tests/support.mjs`. Put new assertions in the matching topic module, fixtures in
  support — do not grow one file past a few hundred lines.
- `automation-host.mjs` — page-side WS host (page connects to us; one owner of :4180).
- `out/log.jsonl` append-only telemetry, every row `{ts, rid, e, ...}`. `RUNBOOK.md` has
  the operational deep dives; `tmp/` holds throwaway probes (gitignored, but linted).

## Commands (gates before every commit — use `&&`, not `;`)

```
node driver.mjs --selftest          # behavior assertions; must print SELFTEST OK
pnpm run lint > out/lint.txt        # eslint . --max-warnings 0; file must be empty, exit 0
pnpm exec eslint --fix <files>      # after edits (careful: it rewrites JSDoc on arrows)
powershell -File killdrv.ps1        # kill driver+host; the loopdrv supervisor restarts driver
powershell -File tmp/ptree.ps1      # verify EXACTLY ONE chain: service->loopdrv.sh->driver->host
node tmp/watchrun.mjs               # one-shot: exits when the next clean run-digest lands
```

## Conventions & traps (each cost hours at least once)

- Bridge: JSON `{v,id,op,args}`; every `act` needs the LATEST `epoch`; card/control IDs
  are per-observation, never cached across observes. Consumable `kind` is CAPITALIZED in
  observations (lowercase-compare). Setup-overlay `option_cycle` indices are 1-based and
  its stake options are numeric strings, not labels.
- Stake-conditional behavior gates on `run.stake` (skip-small-on-Red lives here). Winning
  knob sets are snapshotted per stake in `out/stake_locks.json`; `policy()` resolves
  own-stake lock -> highest-won-stake inheritance -> `policy.json`. Tune a stake by
  editing its lock entry, never by mutating another stake's winner.
- `out/wins.json` is an OBJECT `{label:1}` (array form corrupted the set once); the
  ladder target = first unwon label in `STAKE_LABELS`; the stake guard aborts
  wrong-stake runs (watch `e:"stakeabort"` rows).
- Digests from mid-run restarts are fragments (rid without `runstart`): filter to
  `complete:true` before any cohort math; cohort censuses key on `decide.stk`/era ts.
- Zombie-pause (all acts `action_unavailable`, state looks clean) is woken by
  `nudgeUnpause()` automatically after 3 turn errors; direct `play`/`discard` verbs are
  the fallback when highlight/select dies (`e:"directverb"` rows).
- Boss semantics come from the game's own `blind.effect` strings, never wiki memory;
  unknown card behavior => ASK THE USER (they are this build's card oracle).
- Prefer small cohesive files everywhere (user standing rule, 10-29): when a file grows
  past ~a few hundred lines, split it along topic seams and keep a thin runner/facade;
  shared helpers move to a `support`/`lib` module rather than being duplicated.
- Never leave two supervisors/hosts alive (:4180 single owner, "already in use" loops);
  service readiness probes never match — verify via ptree/`out/drv-stdout.txt`/state.json.
- Time: `ts` fields are epoch ms (authoritative); console/proc tails use 12-h local.

## Keep updated when

adding a stake-conditional rule, a new `out/` file, a recovery path, or a lint/gate change.
