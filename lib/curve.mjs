/* curve.mjs — power-vs-required scaling state (11-04 whole-corpus study):
   boss targets scale a FIXED curve 2.50x/ante to a4 then 2.20/1.82/1.75/1.43;
   power ratio R = best live hand / current boss target is the dominant late
   predictor (at a4: R<1 -> 31% reach a5, R>=1 -> 91%, R>=2 -> 15% a7 / 7.7% win).
   Tracks R per ante for shop gating + digest telemetry. */

const st = { hand: 0, r: null, r4: null, catchup: false };

/**
 * Feed a live hand-phase score into the ante accumulator.
 *
 * @param {number} chips - current live hand score (obs.run.chips)
 * @returns {void}
 */
export function noteHand(chips) {
    if (chips > st.hand) {
        st.hand = chips;
    }
}

/**
 * Ante boss-select reached: score the accumulated power against the boss
 * target, set the catch-up flag, snapshot r4, reset for the next ante.
 *
 * @param {number} ante - ante just cleared (boss awaiting)
 * @param {number} target - boss blind target
 * @param {boolean} won - run already won (skip flags)
 * @returns {void}
 */
export function noteBlind(ante, target, won) {
    st.r = target > 0 && st.hand > 0 ? st.hand / target : null;
    if (ante === 4) {
        st.r4 = st.r;
    }

    if (!won && st.r !== null && ante >= 3) {
        st.catchup = st.r < 1.1;
    }

    st.hand = 0;
}

/**
 * Reset all curve state (new run).
 *
 * @returns {void}
 */
export function resetCurve() {
    st.hand = 0;
    st.r = null;
    st.r4 = null;
    st.catchup = false;
}

/** Live curve state (read-only by convention). */
export const curve = st;
