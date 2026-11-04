/* curve.mjs — power-vs-required scaling state (11-04 whole-corpus study):
   boss targets scale a FIXED curve 2.50x/ante to a4 then 2.20/1.82/1.75/1.43;
   power ratio R = best live hand / current boss target is the dominant late
   predictor (at a4: R<1 -> 31% reach a5, R>=1 -> 91%, R>=2 -> 15% a7 / 7.7% win).
   Tracks R per ante for shop gating + digest telemetry. */

const st = { hand: 0, r: null, r4: null, catchup: false };

/**
 * Feed a live score into the ante accumulator (pre-play running total AND the
 * post-score total after each successful play; max wins).
 *
 * @param {number} chips - live blind-accumulated score (post-score preferred)
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
 * @param {string} [bossEffect] - boss effect text joined (scoring-crushers force
 * catchup regardless of R: R cannot see effects - The Needle killed an R=2.23 run,
 * The House an R=1.09 one; texts ride the blind rows verbatim, no oracle needed)
 * @returns {void}
 */
export function noteBlind(ante, target, won, bossEffect = '') {
    st.r = target > 0 && st.hand > 0 ? st.hand / target : null;

    if (ante === 4) {
        st.r4 = st.r;
    }

    if (!won && ante >= 3) {
        /* no score reading (r=null) keeps the previous flag; a crushing boss
           text forces catchup even at R>=1 */
        const behind = st.r === null ? st.catchup : st.r < 1.1;

        st.catchup = behind || /only 1 hand|face ?down|debuffed|halved|decrease level/i.test(bossEffect);
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
