/* Run-end digest: pure per-run rollup from telemetry accumulators (extracted from driver.mjs). */

import { curve } from './curve.mjs';

const PNAME = /^(mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)/i;

/* last strategy-family the blind handler committed to this run (setIntent);
   intentSet distinguishes "no strategy row seen yet" from an explicit raw-EV run */
let intentSet = false;
let intentFam = null;

/**
 * Record the run's current grind family for digest alert semantics.
 *
 * @param {string|null} fam - chooseStrategy family, or null for raw-EV runs
 */
export function setIntent(fam) {
    intentSet = true;
    intentFam = fam;
}

/**
 * Build the rundigest row.
 *
 * @param {object} p - inputs
 * @param {object} p.obs - final game-over/game-won observation
 * @param {boolean} p.won - run won
 * @param {object} p.runStats - driver per-run accumulators (lvl, acts, jmax, fams)
 * @param {object[]} p.handsSnap - last non-empty hands table seen this run
 * @param {boolean} p.complete - this session saw the runstart (else digest is a fragment)
 * @returns {object} digest fields (sans t/rid envelope)
 */
export function buildDigest({ obs, won, runStats, handsSnap, complete }) {
    const A = runStats.acts;
    const lvlAct = runStats.lvl + A.filter((a) => /^planet:/.test(a)).length + A.filter((a) => /^take:/.test(a) && PNAME.test(a.slice(5))).length;
    /* focal = the game's OWN most-played-family counters (hands rows played/
       times_played — same signal Telescope uses); decision-row counting mislabels
       hands the game scored differently (rid ...180: bot logged TP x4, game rows
       showed Full House played=5, and the Earth take was in fact correct).
       runStats.fams only as fallback when the table lacks counters */
    const H = (obs.hands && obs.hands.length) ? obs.hands : handsSnap;
    const rowsP = (H || []).map((h) => ({ f: h.name, p: Number(h.played ?? h.times_played) || 0, lvl: Number(h.level) || 1 })).filter((r) => r.f && r.p > 0);
    const focal = rowsP.slice().sort((a, b) => b.p - a.p || b.lvl - a.lvl)[0] || null;
    const focalName = focal ? focal.f : (Object.entries(runStats.fams).sort((a, b) => b[1] - a[1])[0] || [null])[0];
    let focalPlaysN = 0;

    if (focal) {
        focalPlaysN = focal.p;
    } else if (focalName) {
        focalPlaysN = runStats.fams[focalName] || 0;
    }

    const focalLvl = focal ? focal.lvl : null;
    const lvlMap = (H || []).filter((h) => (Number(h.level) || 1) > 1).map((h) => `${h.name}:${h.level}`).join(',');
    /* ALERT SEMANTICS (11-04 census 9/27): focal is a BOARD-FREQUENCY label, not the
       driver's intent - 6/9 old LOW_FOCAL flags had in fact leveled their true strategy
       family (weak boards just only MAKE Pair/Two Pair, see the focal!=intent ledger).
       Intent-aware rules: PLANET_SUPPLY_MISS = the strategy family never got a level by
       ante>=3 despite the run buying planets (a real targeting/supply failure);
       LOW_FOCAL_LEVEL keeps its meaning ONLY when focal is also the intent family.
       intent 'unset' (death before first strategy row) keeps the legacy rule. */
    const intentLvl = intentSet ? Number((H || []).find((h) => h.name === intentFam)?.level) || 1 : null;
    let alert = null;

    if (!won && intentSet && intentFam && intentLvl <= 1 && lvlAct >= 1 && (obs.run?.ante ?? 0) >= 3) {
        alert = 'PLANET_SUPPLY_MISS';
    } else if (!won && focalLvl !== null && focalLvl <= 2 && focalPlaysN >= 8 && (!intentSet || intentFam === focalName || intentFam === null)) {
        alert = 'LOW_FOCAL_LEVEL';
    } else if (!won && (obs.run?.ante ?? 0) >= 5) {
        alert = 'CHIP_GAP';
    }

    /* gap = REAL post-play shortfall of the final blind (set at every play decide;
       user 10-30: CHIP_GAP label alone asserted a cause it never measured) */
    const gap = runStats.gap ?? null;

    return {
        e: 'rundigest',
        gap,
        won,
        ante: obs.run?.ante,
        focal: focalName,
        focalPlays: focalPlaysN,
        focalLvl,
        intent: intentSet ? intentFam : 'unset',
        lvlMap,
        lvlAct,
        uses: runStats.lvl,
        rerolls: A.filter((a) => a === 'reroll').length,
        celestial: A.some((a) => a.startsWith('pack:') && /celestial/i.test(a)),
        jokers: runStats.jmax,
        r4: curve.r4,
        alert,
        complete,
    };
}

/**
 * Clear per-run accumulators after digesting.
 *
 * @param {object} runStats - the driver accumulator object to reset in place
 */
export function resetRunStats(runStats) {
    for (const k of Object.keys(runStats.fams)) {
        delete runStats.fams[k];
    }

    runStats.lvl = 0;
    runStats.gap = null;
    runStats.acts.length = 0;
    runStats.jmax = 0;
    intentSet = false;
    intentFam = null;
}
