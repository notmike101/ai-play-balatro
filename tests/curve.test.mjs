/* Selftest chunk: curve catch-up flag incl boss-effect force (run via selftest.mjs). */

/**
 * Curve state-machine assertions: R math, behind flag, scoring-crusher boss
 * force (R-blind), null-r flag carry, ante scope, won skip.
 * Throws on first failure.
 *
 * @returns {Promise<void>}
 */
export async function runCurve() {
    const { noteBlind, noteHand, resetCurve, curve } = await import('../lib/curve.mjs');

    /* behind: R<1.1 at a4 sets both r4 and catchup */
    resetCurve();
    noteHand(3_000);
    noteBlind(4, 4_000, false, 'Small Blind and Big Blind defeated');

    if (curve.r4 !== 0.75 || curve.catchup !== true) {
        throw new Error(`curve behind drift ${JSON.stringify(curve)}`);
    }

    /* force: scoring-crusher text sets catchup at R=2.2 (Needle-class) */
    resetCurve();
    noteHand(22_000);
    noteBlind(4, 10_000, false, 'Play only 1 hand');

    if (curve.r4 !== 2.2 || curve.catchup !== true) {
        throw new Error(`needle-force drift ${JSON.stringify(curve)}`);
    }

    /* benign texts at strong R never force, even right after a forced run */
    resetCurve();
    noteHand(22_000);
    noteBlind(3, 10_000, false, 'The Eye chooses the hand');
    noteHand(25_000);
    noteBlind(4, 10_000, false, 'Only single cards can be played');

    if (curve.catchup !== false) {
        throw new Error(`benign-boss force leak ${JSON.stringify(curve)}`);
    }

    /* null-r (no score since last reset) CARRIES the previous flag */
    resetCurve();
    noteHand(3_000);
    noteBlind(3, 4_000, false, 'benign text'); /* behind -> true */
    noteBlind(4, 10_000, false, 'benign text'); /* hand=0 -> r=null -> carry true */

    if (curve.r4 !== null || curve.catchup !== true) {
        throw new Error(`null-r carry drift ${JSON.stringify(curve)}`);
    }

    /* ante<3 never touches the flag; a won run skips even with force text */
    resetCurve();
    noteHand(100);
    noteBlind(2, 10_000, false, 'Base Chips and Mult are halved');

    if (curve.catchup !== false) {
        throw new Error(`ante-scope leak ${JSON.stringify(curve)}`);
    }

    noteHand(100);
    noteBlind(4, 10_000, true, 'Play only 1 hand');

    if (curve.catchup !== false) {
        throw new Error(`won-flag leak ${JSON.stringify(curve)}`);
    }

    resetCurve();
}
