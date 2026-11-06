# AGENTS.md

Autonomous Balatro player for the poker.gl.ax web build. `driver.mjs` observes and acts through a WebSocket bridge; the supervised driver grinds the stake ladder without an agent deciding every move. The *research agent* wakes periodically to interpret evidence, improve the policy, preserve knowledge, and return control to the driver.

**Mission:** Learn from unattended play without losing experimental integrity, run progress, or discoveries across context resets. Every wakeup must either advance a measurable question, repair a proven operational problem, or leave a sound experiment running. Activity is not progress.

## Authority and durable knowledge

Read in this order at the start of **every** wakeup:

1. `AGENTS.md` — enduring constraints and process; **not** a running diary.
2. `WAKE_STATE.md` — bounded, current handoff: active experiment, evidence cursor, blockers, exact next action. Create it from its template if missing; treat it as *unverified* until reconciled with live state.
3. Latest relevant entries in `status-YYYY-MM-DD.md` and `RUNBOOK.md` — experiment history and operational/validated reference material. Status notes are historical reports, not proof of current runtime state; read recent relevant sections, not entire oversized logs.
4. Actual git tree, processes, runtime logs, and `out/` files — authoritative for what is running and what occurred. Resolve conflicts with direct inspection; never silently choose the most convenient version.

**Sources of truth:**

- `out/log.jsonl` is append-only event telemetry (`{ts,rid,e,...}`); `out/results.jsonl` and `out/digests.jsonl` record outcomes. `out/runs.db` is a **derived** SQLite index, rebuilt/incrementally refreshed via `node tools/dbimport.mjs`.
- `out/wins.json`, `out/stake_locks.json`, `out/stake_map.json`, and `out/policy.json` are persistent ladder/policy state. `out/wins.json` must remain an **object** (`{"White Stake":1}`), never an array. Do not infer current progression from a dated status paragraph or winning policy locks alone.
- `RUNBOOK.md` contains operational procedures and **validated** build facts, with evidence references. Invalidated or merely plausible mechanics do not become facts there.
- `status-YYYY-MM-DD.md` is the chronological record of experiments, failed ideas, incidents, and decisions; append concise, evidence-linked entries when something material changes. Do **not** copy raw telemetry into it.
- `WAKE_STATE.md` is the **one** short resumable working memory. Track it in git and checkpoint substantive changes before relinquishing control; do not create a commit merely because four more runs arrived. Historical detail belongs in the status log, not in this bounded file.

Never rely on remembered model context alone. If a claim cannot be traced to a file, sample, in-game probe, or oracle answer, label it as uncertain.

## Layout (verify against the working tree before making changes)

- `driver.mjs` — phase-driven observe -> decide -> act loop; run, blind, shop, pack, and setup coordination.
- `lib/link.mjs` / `automation-host.mjs` — single-owner WebSocket bridge at `127.0.0.1:4180`; CDP recovery over loopback `:9222`.
- `lib/acts.mjs` — action primitives, selection/direct-verb fallback, tarot targeting, lineup synchronization, deck observations.
- `lib/playturn.mjs` — hand/blind turn pipeline, bank sync, consumable prep, decisions, telemetry, error recovery.
- `lib/play.mjs`, `lib/jmodel.mjs`, `lib/routes.mjs` — hand evaluation, joker/order prediction and calibration, shadow play/discard route estimates. A shadow estimate is **not** authority to change live decisions.
- `lib/strategy.mjs`, `lib/jokers.mjs`, `lib/shop.mjs`, `lib/curve.mjs` — family focus, joker valuation, buy/pack rules, power-vs-target catch-up policy.
- `lib/knowledge.mjs`, `lib/digest.mjs`, `lib/reps.mjs` — durable state/events, end-of-run rollups, run/ante counters.
- `tests/` — topic-local assertions and shared fixtures; `node driver.mjs --selftest` is the canonical entry point. Add tests to the matching topic module, not a monolithic runner.
- `tools/` — committed, linted analysis tools: `wake.mjs`, `watchrun.mjs`, `dbimport.mjs`, `cohort.mjs`, and question-specific censuses. `tmp/` is ignored, operational/scratch tooling but **still linted**; delete one-off probes once a question closes.

The deeper module map, game-profile recovery, and operational commands live in `RUNBOOK.md`. Update the map when code changes; do not turn this file into a second runbook.

## Every wakeup: mandatory cycle

A **wakeup is an observation boundary, not a policy-change boundary**. An active run or cohort continues across wakeups. Do not reset a run, discard its evidence, restart a supervisor, or modify gameplay merely because the agent context was refreshed.

### 1. Reconstruct and verify

- Read the durable context above. Identify the current question, its pre-registered verdict criteria, last processed digest time (`t`), experiment status, and what should happen next.
- Inspect `git status --short`, `git rev-parse HEAD`, the latest relevant diff, live `out/` state, and the most recent `sessionstart`/`runstart`/`runend`/`rundigest`. Determine whether the running driver actually loaded the expected code.
- Verify **one** driver/host chain and **at most one** watcher/wake-loop owner. Prefer `powershell -File tmp/ptree.ps1`, `out/drv-stdout.txt`, and process state over port-listening or service-ready guesses. A persistent wake-loop may already own batch commits; do not create a competing watcher.
- Check for unexplained rollback, missing results, stale imports, duplicate run IDs, mid-run restarts, profile/save loss, or a stopped supervisor. Recover operational integrity **before** analyzing strategy.
- If `WAKE_STATE.md` is stale, reconstruct from the logs and status history. Record the mismatch and fix the handoff; never force real data to match a stale note.

### 2. Import and examine new evidence

- Run `node tools/wake.mjs` for an initial readout (it imports the log first), then use targeted tools such as `node tools/cohort.mjs`, `node tools/cohort.mjs --verdict <sha>`, `node tools/route.mjs <since-ts>`, or `node tools/curve.mjs <since-ts> [until-ts]` **only when relevant**. Examine raw sample rows before trusting a new join or field name.
- Compare **only the new window** against the frozen hypothesis and baseline. For performance/mechanics analysis, use clean, complete run digests and correct policy-era boundaries. Mid-run fragments are not full runs. For **mastery accounting**, however, every attempted run—including crashes, interruptions, and deliberate early aborts—remains in the denominator; see below.
- Record counts and denominators, not adjectives: stake, attempts, clean n, win rate, mean/median ante, ante-depth distribution, run duration, win/attempt throughput, and the specific mechanism metric under study. Separate board/deal variance, prediction error, supply/economy, strategic choices, runtime defects, and bad telemetry.
- **A watcher batch** (`WATCH_N=4` in the example below; the persistent service may use another size) is a notification, **not** a verdict. Use **at least eight clean digests** for an initial noncritical pattern check; a policy verdict needs its own pre-registered sample/stop rule and typically more data. Do not mistake an early favorable sample for repeatable improvement.

### 3. Choose exactly one primary outcome

Use the smallest action supported by evidence:

- **WAIT:** No credible new signal or the pre-registered sample is incomplete. Preserve the frozen policy and continue collecting runs. Doing nothing to gameplay is often correct.
- **PROBE:** A specific uncertainty blocks a decision. Prefer a targeted read-only census, ground-truth join, or shadow instrument before building a new model.
- **EXPERIMENT:** Strong enough evidence identifies one controllable lever. Pre-register the change and comparison *before* modifying behavior.
- **FIX:** A reproducible correctness, integrity, or liveness defect exists. Repair with a regression test and explicitly invalidate affected measurements if needed.
- **ASK ORACLE:** Essential mechanics are inaccessible or ambiguous in this web build. Ask the user one precise question with an observed example; never fill the gap with vanilla Balatro lore or a wiki assumption.
- **AUDIT:** A scheduled, behavior-preserving code-health wave is due and is safe for the active cohort.

Select by expected impact on **verified stake progression and repeatability**, not by novelty, recent anecdotes, or a desire to make a commit. Keep no more than three ranked candidates in `WAKE_STATE.md`. If the next action is blocked, state the evidence needed to unblock it rather than inventing substitute work.

### 4. Close the wakeup and make it resumable

Before yielding control or arranging the next observation:

1. Update `WAKE_STATE.md`: UTC time, actual HEAD/runtime identity, stake, watcher ownership, last examined digest `t`, active experiment, new sample counts, verdict status, blockers, and **one exact next action/trigger**.
2. Append a compact entry to the latest status log **only** for a real discovery, experiment registration/verdict, important non-result, incident, or code change. Include experiment ID, evidence query/rows, sample sizes, alternative explanations, and why the decision follows.
3. Put **validated** mechanics/operations in `RUNBOOK.md`; update `AGENTS.md` only when a durable process, invariant, or tool contract changes. Record rejected hypotheses in status history so they are not retested without a new differentiating signal.
4. Ensure the driver remains healthy and only the intended watcher is armed. A watcher that exits after a batch **does not itself launch a new reasoning session**: the outer agent scheduler must resume the agent. Never claim automatic future reasoning if no such orchestrator exists.

## Watching without losing the run loop

The existing one-shot chain, when no persistent watcher owns it, is (in **bash**):

```bash
T=$(node tools/wake.mjs | tail -1) && WATCH_N=4 node tools/watchrun.mjs "$T"
```

- `tools/wake.mjs` prints a fresh analysis and the latest digest timestamp **on its last line**. `tools/watchrun.mjs` exits after the requested number of **new clean** digests, with a partial-batch fallback near its deadline. Treat timeout/no-new-digest as an operational check, not a gameplay result.
- Read the current `RUNBOOK.md` and process topology first: a newer `wakeloop`/equivalent service may already own batch watches and result commits. Do not double-arm it. Re-arm a one-shot watcher **only** when that is the active orchestration mode.
- Preserve a monotonic last-consumed digest cursor. Do not restart counting at zero after each wakeup, miss rows that landed during a context reset, or double count rows after a rearm. Use `rid` plus digest `t` to deduplicate; `ts` event clocks are epoch milliseconds.
- A running game and a waiting research agent are separate concerns. No speculative process restart, page reload, profile reset, or interactive action merely to create fresh evidence. Use the `RUNBOOK.md` recovery procedure for actual failures.

## Evidence standard (mandatory for every claim)

- **HYPOTHESIS:** plausible but unproven mechanism or benefit. May justify a probe; **must not** silently drive live policy.
- **OBSERVATION:** seen in a few cases, traces, or screenshots. Record n, conditions, and counterexamples; not proof of causality.
- **VALIDATED:** repeated/controlled **game-build** evidence: matching action/outcome joins, a complete census with denominators, a suitable controlled comparison, or a game-grounded test of a user-provided oracle explanation. Oracle answers supply missing descriptions, but do not by themselves prove an implementation works. Required for mechanics claims in code comments, scoring formulas, and `RUNBOOK.md`.

Always separate **mechanical correctness** (does the change fire and do what it claims?) from **performance impact** (does it improve runs?). A mechanism may work while its primary performance endpoint fails. Mark that `MECHANISM-ONLY` or `INCONCLUSIVE`, **not** a successful performance verdict. Never change success criteria after seeing the outcome without documenting a new experiment.

**Known traps:** `e:planet.fam` before the `gamefam:` probe was a model label, not game truth; Supernova/Stencil assumptions, handstab staleness, Black Hole, Baseball rarity, Mime targeting, greedy-family rarity, and interest all produced false confident claims. Recheck inherited comments against evidence; vanilla recall is never a substitute for this build's behavior. Boss rules come from `blind.effect` text; unknown card effects go to the user as oracle.

Analysis itself must be validated: inspect field names (`packdump` shorthand differs from `shopdump`), join the **same** blind/observation, distinguish `rundigest.t` from event `ts`, and filter old no-`ts` event rows by the *positive* condition `r.ts >= since`. A new Monte Carlo solver must first demonstrate valid draws, legal actions, enhancements/order handling, calibration, and nontrivial discriminating predictions **in shadow mode**.

## Experiment and policy change protocol

**Pre-register before behavior changes.** Verify the underlying game mechanics before live treatment; an uncertain *performance effect* may be tested as a controlled hypothesis, but unverified mechanics may not silently drive live play. In `WAKE_STATE.md` record:

- `ID` and status; problem/failure class; evidence trace and baseline period; suspected mechanism, alternatives, and what would falsify it.
- **One** intervention (code/config path) and the predicted behavioral effect. Preserve a control window with the incumbent policy; do not change unrelated knobs simultaneously.
- Effective runtime policy/config, git SHA, relevant worktree diff, code-live `sessionstart` time, stake, and starting `rid`/digest `t`. **`deploy` rows derived from commit timestamps do not prove loaded code.** `tools/wake.mjs`'s code-era grouping is a convenience, not a guarantee that live `out/policy.json`, stake locks, game profile, or host behavior stayed constant.
- Primary endpoint, mechanism/diagnostic endpoint, regression guards, minimum sample size, stopping time/condition, and `KEEP` / `REVERT` / `INCONCLUSIVE` rule. Choose metrics/thresholds *before* the first treatment run. If regime or random variance is large, expand the predeclared observation period rather than rationalizing a tiny favorable batch.

**Implementation order:** instrument/ground truth -> reproduce -> smallest code change -> topic regression test -> selftest/lint -> commit/diff inspection -> confirm live boot and decision telemetry -> gather frozen cohort -> adjudicate against preregistration -> document verdict. A behavior change during a cohort (even a live policy JSON edit without restart) starts a **new** era and resets any affected mastery window. Explicit emergency fixes may interrupt an experiment, but invalidate its old verdict window.

**Verdicts:** A positive mechanism signal without a primary-endpoint benefit is not a proven strategy improvement; record it precisely. A failed or inconclusive experiment is valuable knowledge; archive the negative result and do not repeat it unless a new fact changes the premise. If a shadow model shows ties/contradictions or broken data, repair the measurement rather than wiring it into production. No opportunistic mid-cohort tuning, cherry-picked seeds, or post-hoc subgroup claims.

**Run-specific strategy:** The *decision policy* stays fixed during evaluation, but each game should build and adapt its own long-term plan from **visible** deck, jokers, economy, boss effects, and observed performance. Pivot when the live game justifies it; do not force a predetermined family or alter program code to rescue a single run. Never feed future shop contents, hidden card order, face-down identities, debug state, or information a human player cannot see into live decisions. Research-only state must remain isolated from policy inputs.

**Early-abort experiments:** Verify that exit/restart behavior is legitimate and save-safe **before** any live abort. Record each abandoned run as an **attempt with an explicit reason/outcome**, never erase it or silently restart at Ante 1. Report wins per all attempts and wins per wall-clock time separately; early termination must not make mastery statistics look better by dropping failures. Save/profile integrity incidents require a postmortem and regression guard.

## Stake ladder: progression is not mastery

- **Progression:** one verified victory over the Ante 8 Boss Blind unlocks the next stake. Derive the current target from actual `out/wins.json` and ladder state on every wakeup; do not keep a dated “current standing” in this file.
- **Mastery:** **at least 9 wins in 30 consecutive autonomous attempts (30%)** on the **same stake** with an unchanged gameplay/scoring policy. All losses, crashes, interruptions, and intentional aborts count. A 30-run window interrupted by any behavior-affecting change **resets**.
- Archive every benchmark with policy identity, git SHA, effective config, period, attempt ledger, win rate, average ante, and run duration. Mark unsupported identities/holes as unverified; do not invent records to fill them.
- A single win proves a policy *can* win, not that it is mastered. No wins-per-day quota. Track throughput to diagnose inefficiency, never to redefine mastery.

## Operational contracts and pitfalls

- Bridge protocol `{v,id,op,args}`. Every `act` uses the **latest** observed `epoch`; card/control IDs are observation-local. Consumable `kind` arrives capitalized; compare case-insensitively. Setup `option_cycle` is **1-based**, with numeric-string stake options.
- Stake-conditional logic gates on `run.stake`; `policy()` resolves own-stake lock -> highest-won-stake inheritance -> `out/policy.json`. Tune an effective stake policy without corrupting another stake's winning snapshot. Verify what resolves at runtime, not merely what file was edited.
- `stakeabort` events mean the run-target guard intervened. Mid-run restart digests can be fragments; use `complete:true` plus lifecycle checks for clean cohort math. Never use a fragment to silently erase an attempted run.
- Automatic zombie-pause recovery invokes `nudgeUnpause()` after repeated turn errors; direct `play`/`discard` verbs recover dead highlighting. One bridge owner, one driver/supervisor chain, one watcher. Verify by process tree and live `sessionstart`, not port presence alone.
- A Chromium/profile reset can erase unlocks and runs. Consult `RUNBOOK.md` before manipulating the game profile, service chain, browser foreground/headless mode, or save system. Time fields `ts` are epoch **milliseconds**, not displayed 12-hour console times.
- Keep files cohesive: when a file grows beyond a few hundred lines, split by genuine responsibility with a thin facade. Prefer deletion, existing helpers, native language features, and simple code over speculative interfaces, configuration layers, or new abstractions. Never optimize without a measured bottleneck.

## Verification, deployment, and commits

Before **every** code commit, run the gates and check their actual exit status (join dependent commands with `&&`, not `;`):

```bash
node driver.mjs --selftest && pnpm run lint > out/lint.txt 2>&1
# Verify SELFTEST OK, final exit code 0, and zero lint problems.
# If pnpm/npx fail on EBADDEVENGINES, run the installed ESLint binary directly:
node node_modules/eslint/bin/eslint.js <files> --quiet
```

- For changed behavior, add focused regression assertions **and** confirm a real post-deploy `decide`/act/outcome trace; offline tests alone do not prove the bridge or chosen policy is live.
- `pnpm exec eslint --fix <files>` is permitted after edits but can rewrite JSDoc. Check its diff; validate again. Temporary scripts must also pass lint.
- Use Conventional Commits: `type(scope): description` (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`). Data/log refreshes: `chore(data): ...`. No `WIP`, `policy:`, or `data:` prefixes.
- After every commit, compare **`git show --stat` and `git show --name-only` with the actual intended file list**, and inspect the diff. A commit that omits a local behavior change is **not** a reproducible experiment; the working tree is the deployment source.
- A push/commit timestamp or synthesized `deploy` row is **not** proof the running driver reloaded. Verify live `sessionstart` (and, for relevant config changes, effective policy at decision time) per `RUNBOOK.md`. Never kill the supervisor merely to publish a docs-only change.

## Code-health review cadence

A full-repo audit is required **at each concluded behavior cohort or significant code-structure change**, not at every four-run wakeup. Keep it in separate, behavior-preserving waves (one topic per commit; no unnecessary mid-run restart):

1. **Accuracy:** verify comments, JSDoc signatures, command paths, telemetry names, and `RUNBOOK.md` against code and game evidence; delete unverified claims.
2. **Simplicity:** find dead code, unused exports, redundant abstractions, and oversized files. Apply the existing `delete:` / `stdlib:` / `native:` / `yagni:` / `shrink:` audit tags where useful.
3. **Modularity:** isolate cohesive state and helpers without behavior changes; keep facade compatibility and focused tests.
4. **Measured performance:** benchmark real hot paths before optimizing; document “not a bottleneck” when that is the conclusion.

Gate, commit, inspect, and push each wave independently. If behavior preservation is not demonstrable, classify the change as a **new experiment** and reset affected cohorts; do not camouflage it as refactoring.

## Definition of a completed wakeup

A wakeup is complete when: the actual runtime/data state is known (or the uncertainty is recorded); new evidence has been consumed exactly once; the active hypothesis has an unchanged, testable next condition or a documented verdict; `WAKE_STATE.md` names the next action and evidence cursor; durable findings are written to the correct place; and the autonomous driver/watcher topology is intact. **When evidence does not justify a change, keep collecting it.**
