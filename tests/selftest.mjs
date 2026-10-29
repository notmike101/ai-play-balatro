/* Assertion suite entry: `node driver.mjs --selftest` runs every topic module below. */
import { runHandFamilies } from './handfams.test.mjs';
import { runJokerLineup } from './lineup.test.mjs';
import { runCalibration } from './calibration.test.mjs';
import { runPolicy } from './policy.test.mjs';
import { runJokerEffects } from './jokerefx.test.mjs';
import { runDigest } from './digest.test.mjs';

/**
 * Run every policy/evaluator assertion; throws on first failure.
 */
export async function runSelftest() {
    await runHandFamilies();
    await runJokerLineup();
    await runCalibration();
    await runPolicy();
    await runJokerEffects();
    await runDigest();
}
