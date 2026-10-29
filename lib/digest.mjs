/* Run-end digest: pure per-run rollup from telemetry accumulators (extracted from driver.mjs). */

const PNAME = /^(mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)/i;

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
    let alert = null;

    if (!won && focalLvl !== null && focalLvl <= 2 && focalPlaysN >= 8) {
        alert = 'LOW_FOCAL_LEVEL';
    } else if (!won && (obs.run?.ante ?? 0) >= 5) {
        alert = 'CHIP_GAP';
    }

    return {
        e: 'rundigest',
        won,
        ante: obs.run?.ante,
        focal: focalName,
        focalPlays: focalPlaysN,
        focalLvl,
        lvlMap,
        lvlAct,
        uses: runStats.lvl,
        rerolls: A.filter((a) => a === 'reroll').length,
        celestial: A.some((a) => a.startsWith('pack:') && /celestial/i.test(a)),
        jokers: runStats.jmax,
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
    runStats.acts.length = 0;
    runStats.jmax = 0;
}
