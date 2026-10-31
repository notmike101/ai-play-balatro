/* lib/need.mjs — ante score-curve tracker (the build's look-ahead, user ask 10-31).
   The game's blind targets grow ~x2 per ante; a build that scores X/hand TODAY must be
   projected against the target curve, not against the blind in front of it (the greedy
   1-step shop bought the same way at a1 and a7 and died at the a4 5.5x cliff, twice the
   target at once). playturn notes our real best predicted hand-score each decide; shop
   asks needPlan() once per visit: crisis = 4 hands of the current best still cannot pass
   TWO antes ahead -> stop buying lottery tickets, spend on score NOW.
   Pure state; reset per run via resetNeed() (driver run-reset). */
const curve = new Map(); /* ante -> max blind target observed this run */
let best = 0; /* best predicted single-hand score this run */
let lastAnte = 0;

/**
 * Record one blind target observation (ante, target).
 *
 * @param {number} ante - blind ante
 * @param {number} target - blind target chips
 * @returns {void}
 */
function noteTarget(ante, target) {
    if (!ante || !(target > 0)) {
        return;
    }
    if ((curve.get(ante) ?? 0) < target) {
        curve.set(ante, target);
    }
}

/**
 * Record one predicted hand-score from a play decision.
 *
 * @param {number} pred - predicted chips for the played hand
 * @param {number} ante - current ante (resets best on new run/ante-1 re-entry)
 * @returns {void}
 */
function notePred(pred, ante) {
    if (ante === 1 && lastAnte > 1) {
        best = 0;
        curve.clear();
    }
    if (ante) {
        lastAnte = ante;
    }
    if (pred > best) {
        best = pred;
    }
}

/**
 * Extrapolated target for a future ante. Growth factor comes from the OBSERVED pair
 * when two adjacent antes are known (the a3->a4 jump is 5.5x in this build - doubling
 * from a lone a3 point misses the cliff), else x2 per step.
 *
 * @param {number} a - ante to project
 * @returns {number|null} projected target or null when nothing observed yet
 */
function projTarget(a) {
    const known = [...curve.keys()].sort((x, y) => x - y);
    if (known.length === 0) {
        return null;
    }
    let g = 2;
    for (let i = 1; i < known.length; i++) {
        if (known[i] === known[i - 1] + 1) {
            /* max-per-ante mixes blind families (a3 small -> a4 big reads 5.5x); real
               ante-to-ante growth in this corpus tops out ~2.7x - cap the projection */
            g = Math.min(3, Math.max(2, curve.get(known[i]) / curve.get(known[i - 1])));
        }
    }
    const top = known[known.length - 1];
    let v = curve.get(top);
    for (let i = top; i < a; i++) {
        v = curve.get(i + 1) ?? v * g;
    }
    return v;
}

/**
 * Shop-side need plan: CRISIS when 4 hands of our best known play cannot pass the
 * NEXT ante's (projected) target - that blind arrives one shop-cycle after this one,
 * and money spent here is the last transferable score (the corpus dies at the a4
 * cliff one ante after being 'fine' at a3).
 *
 * @param {number} ante - current ante
 * @returns {{crisis: boolean, tight: boolean, best: number, t2: number|null}} mode flags
 */
function needPlan(ante) {
    const t1 = projTarget(ante + 1);
    const t2 = projTarget(ante + 2);
    const cap = best * 4;
    return {
        crisis: t1 !== null && best > 0 && cap < t1,
        tight: t2 !== null && best > 0 && cap < t2,
        best,
        t2,
    };
}

/**
 * Reset all per-run state (call at run start alongside resetShopRun).
 *
 * @returns {void}
 */
function resetNeed() {
    curve.clear();
    best = 0;
    lastAnte = 0;
}

export { noteTarget, notePred, needPlan, resetNeed, projTarget };
