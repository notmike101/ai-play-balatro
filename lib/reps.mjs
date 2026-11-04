/* reps.mjs — run/blind decision STATE island extracted from play.mjs (zero behavior
   delta, wave-3 modularity): per-blind repeat-family counters (Card Sharp X3 window)
   and the run-scope seen-cards tracker (Blue Joker unseen pricing). The predictor
   consumes these through getRoundReps()/unseenCopies()/roundRepsOf(). */

const roundReps = {};
let roundBase = null;

/* RUN-SCOPE SEEN-CARDS tracker (B2, Blue Joker +2 chips per card still full-in-deck —
   never drawn this run and not in hand, ORACLE text). Card ids are per-observation, so
   copy identity uses rank|suit + the deck manifest (obs.deck.composition rows carry a
   per-combo COUNT): unseen = SUM copies - max copies ever seen simultaneously per combo.
   ponytail: duplicate combos drawn on DIFFERENT hands under-count seen (same-copy redraw
   and fresh copy are indistinguishable without ids) - Blue overpredicts by <=2/dup;
   face-down draws stay "unseen" (identity hidden) and do the same direction. */
const seenMult = new Map();

/**
 * Record every identifiable card that has surfaced in a hand (drawn = seen).
 *
 * @param {(object[] | undefined)} cards - hand cards from an observation
 */
function markSeen(cards) {
    const m = new Map();

    for (const c of cards || []) {
        if (c && c.rank !== null && c.rank !== undefined && c.suit) {
            const k = `${c.rank}|${c.suit}`;

            m.set(k, (m.get(k) || 0) + 1);
        }
    }

    for (const [k, n] of m) {
        if ((seenMult.get(k) ?? 0) < n) {
            seenMult.set(k, n);
        }
    }
}

/**
 * Copies still full-in-deck: never-drawn copies of every combo on the manifest.
 *
 * @param {(Array<(string | number)[]> | undefined)} comp - deck composition rows [rank, suit, enh, edition, seal, count]
 * @returns {(number | null)} unseen copy count, null when the manifest is unknown
 */
function unseenCopies(comp) {
    if (!Array.isArray(comp) || !comp.length) {
        return null; /* deck manifest unknown: never guess - Blue stays unpriced */
    }

    let u = 0;

    for (const row of comp) {
        u += Math.max(0, (typeof row[5] === 'number' ? row[5] : 1) - (seenMult.get(`${row[0]}|${row[1]}`) ?? 0));
    }

    return u;
}

/**
 * Drop the run's memory of drawn cards (new run).
 */
function resetSeen() {
    seenMult.clear();
}

const RVN = {
    Ace: 14, A: 14, King: 13, K: 13, Queen: 12, Q: 12, Jack: 11, J: 11,
};

/**
 * Unseen-copy INDEX of the remaining deck: per-suit and per-rank counts of cards
 * still drawable (manifest minus this run's seen tracker). Feeds draw-EV discards:
 * "what could actually come up" when we discard k and redraw k.
 *
 * @param {(object[] | undefined)} comp - deck composition rows [rank, suit, enh, edition, seal, count]
 * @returns {(object | null)} {suit, rank (numeric rank values), total} or null when the manifest is unknown
 */
function unseenIndex(comp) {
    if (!Array.isArray(comp) || !comp.length) {
        return null;
    }

    const suit = {};
    const rank = {};
    let total = 0;

    for (const row of comp) {
        const n = Math.max(0, (typeof row[5] === 'number' ? row[5] : 1) - (seenMult.get(`${row[0]}|${row[1]}`) ?? 0));

        if (n <= 0) {
            continue;
        }

        suit[row[1]] = (suit[row[1]] || 0) + n;
        const rvn = RVN[row[0]] ?? RVN[String(row[0]).charAt(0).toUpperCase() + String(row[0]).slice(1)] ?? Number(row[0]);

        if (Number.isFinite(rvn)) {
            rank[rvn] = (rank[rvn] || 0) + n;
        }

        total += n;
    }

    return { suit, rank, total };
}

/**
 * Reset the per-blind repeat-family counters (new blind = new Balatro 'round',
 * which is Card Sharp's X3 condition window). Clears the baseline so the next
 * syncReps re-seeds it from the game's cumulative played counters.
 */
function resetRoundReps() {
    roundBase = null;

    for (const k of Object.keys(roundReps)) {
        delete roundReps[k];
    }
}

/**
 * Derive this blind's repeat counters from the game's OWN cumulative per-hand-type
 * counters: reps[fam] = played_now minus the blind-start baseline. The counter is the
 * single source of truth (predicted fam mislabels what the game actually scored) and
 * reps are derived, so the state is self-healing — a missed or pre-animation result
 * table is simply picked up by the next sync that sees the moved counter instead of
 * losing the delta forever. The first sync after a reset seeds the baseline; rows
 * without explicit counters contribute nothing; a missing table never clobbers state.
 *
 * @param {(object[] | undefined)} hands - current per-hand-type rows with played counters
 */
function syncReps(hands) {
    if (!Array.isArray(hands) || !hands.length) {
        return;
    }

    if (!roundBase) {
        roundBase = {};

        for (const h of hands) {
            const p = h && Number(h.played ?? h.times_played);

            if (h?.name && Number.isFinite(p)) {
                roundBase[h.name] = p;
            }
        }

        return;
    }

    for (const k of Object.keys(roundReps)) {
        delete roundReps[k];
    }

    for (const h of hands) {
        const p = h && Number(h.played ?? h.times_played);

        if (h?.name && Number.isFinite(p) && roundBase[h.name] !== undefined) {
            roundReps[h.name] = Math.max(0, p - roundBase[h.name]);
        }
    }
}

/**
 * Repeat counts for the CURRENT blind (Card Sharp: fam already played this round).
 *
 * @returns {object} fam -> times played this blind
 */
function getRoundReps() {
    return roundReps;
}

/**
 * Number of distinct rank|suit combos seen this run (selftest probe).
 *
 * @returns {number} seen combos
 */
function seenN() {
    return seenMult.size;
}

/**
 * Remaining-deck MULTISET: every still-drawable copy as {rank(numeric), suit, enh}
 * (manifest minus run-seen tracker). Feeds the Monte-Carlo hold EV (mc.mjs) with the
 * JOINT deck the marginal index cannot express (11-04 cohort-23).
 *
 * @param {(Array<(string | number)[]> | undefined)} comp - deck composition rows [rank, suit, enh, edition, seal, count]
 * @returns {(object[] | null)} drawable cards or null when the manifest is unknown
 */
function unseenDeck(comp) {
    if (!Array.isArray(comp) || !comp.length) {
        return null;
    }

    const out = [];

    for (const row of comp) {
        const n = Math.max(0, (typeof row[5] === 'number' ? row[5] : 1) - (seenMult.get(`${row[0]}|${row[1]}`) ?? 0));
        const rank = typeof row[0] === 'number' ? row[0] : (RVN[row[0]] ?? (Number(row[0]) || 0));

        for (let i = 0; i < n; i++) {
            out.push({ rank, suit: row[1], enh: row[2] || '' });
        }
    }

    return out;
}

export { markSeen, unseenCopies, resetSeen, unseenIndex, unseenDeck, resetRoundReps, syncReps, getRoundReps, seenN };
