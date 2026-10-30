// knowledge.mjs — persistent state, logging, strategy knobs, joker/joker-factor knowledge.
import fs from 'node:fs';
import path from 'node:path';

// poker-agent/ (automation-host.mjs lives here)
const DIR = path.join(import.meta.dirname, '..');
const OUT = path.join(DIR, 'out');

fs.mkdirSync(OUT, { recursive: true });

const logF = fs.createWriteStream(path.join(OUT, 'log.jsonl'), { flags: 'a' });

const resF = fs.createWriteStream(path.join(OUT, 'results.jsonl'), { flags: 'a' });
let runId = 0;
/**
 * Append a JSON line to the run log (out/log.jsonl), stamped with run id and wall time.
 *
 * @param {object} o - record to serialize and append (mutated with ts/rid)
 * @returns {boolean} whether the log stream buffered the line
 */
const jw = (o) => logF.write(`${JSON.stringify({ ts: Date.now(), rid: runId, ...o })}\n`);

/**
 * Assign the run id carried by all subsequently logged events.
 *
 * @param {number} id - monotonic run counter
 */
const setRunId = (id) => {
    runId = id;
};

/**
 * Print a timestamped line to stdout.
 *
 * @param {...unknown} a - values to log
 * @returns {undefined} undefined (console.log has no return value)
 */
const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
/**
 * Wait for a delay to elapse.
 *
 * @param {number} ms - delay in milliseconds
 * @returns {Promise<undefined>} resolves once the delay has elapsed
 */
const sleep = (ms) => new Promise((r) => {
    setTimeout(r, ms);
});

/**
 * Read a JSON file from the out directory, falling back on any error.
 *
 * @param {string} p - file name inside the out directory
 * @param {object} d - fallback returned when the file is missing or unparseable
 * @returns {object} parsed JSON contents, or the fallback
 */
function tryLoad0(p, d) {
    try {
        return JSON.parse(fs.readFileSync(path.join(OUT, p), 'utf8'));
    } catch {
        return d;
    }
}

// stake->winning-policy snapshots (see policy(); preserve-per-stake directive 10-29)
const stakeLocks = tryLoad0('stake_locks.json', {});
// live run stake number (driver updates each loop); policy() resolves locks against it
let stakeCtx = null;

/**
 * Record the stake number the driver loop is currently observing.
 *
 * @param {number | null} n - live run stake number, or null outside a run
 */
function setStakeCtx(n) {
    stakeCtx = n;
}

/**
 * Persist the policy snapshot that won a stake.
 *
 * @param {string} label - stake label (eg "Red Stake")
 * @param {object} snap - policy object in force at win time
 */
function saveStakeLock(label, snap) {
    stakeLocks[label] = snap;
    fs.writeFileSync(path.join(OUT, 'stake_locks.json'), JSON.stringify(stakeLocks, null, 1));
}

// label<->number
const stakeMap = tryLoad0('stake_map.json', {});
/* labels won THIS session; legacy file form was an ARRAY and Object.keys(array)
   returns INDICES ("0"), silently emptying the set -> picker re-ran won stakes
   (10-29: White wins clobbered to ["White Stake"], driver replayed White at Red era).
   Writer now stores {label:1}; loader accepts both forms. */
const winsRaw = tryLoad0('wins.json', {});
const wins = new Set(Array.isArray(winsRaw) ? winsRaw : Object.keys(winsRaw));

/**
 * Persist the session win labels to wins.json (object form: reader keys, not values).
 */
function saveWins() {
    fs.writeFileSync(path.join(OUT, 'wins.json'), JSON.stringify(Object.fromEntries([...wins].map((l) => [l, 1]))));
}

/**
 * Persist the stake label map to stake_map.json.
 */
function saveStakeMap() {
    fs.writeFileSync(path.join(OUT, 'stake_map.json'), JSON.stringify(stakeMap));
}

const STAKE_LABELS = ['White Stake', 'Red Stake', 'Green Stake', 'Black Stake', 'Blue Stake', 'Purple Stake', 'Orange Stake', 'Gold Stake'];

// strategy knobs (editable via policy.json without restart)
/**
 * Load the live strategy knobs.
 *
 * @returns {object} parsed policy.json, or {} when absent
 */
function policy() {
    const live = tryLoad0('policy.json', {});
    const st = stakeCtx;

    if (st >= 1 && st <= 8) {
        const own = stakeLocks[STAKE_LABELS[st - 1]];

        if (own) {
            return own;
        }

        /* unwon stake inherits the HIGHEST already-won stake's locked strategy
           (proven base); per-stake tuning then diverges in stake_locks.json
           without mutating any earlier stake's winning config */
        for (let i = st - 2; i >= 0; i--) {
            const lower = stakeLocks[STAKE_LABELS[i]];

            if (lower) {
                return lower;
            }
        }
    }

    return live;
}

/**
 * Build the scoring-family priority list.
 *
 * @returns {string[]} families from policy, or the default order
 */
function buildFamilies() {
    const p = policy();

    return p.families || ['Flush', 'Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'Straight', 'Four of a Kind', 'Straight Flush', 'High Card'];
}

// family -> observed/expected multiplier EMA (calibrated from real scores)
const jokerFactor = {};

/* joker lineup (name:count joined) under which each family's factor was last
   trained; lineup churn (buy/sell/reorder) invalidates it, so predict gates on it */
const jokerSig = {};

/* actively harmful for our discard-heavy single-family grind: fewer hands / no discards / money traps;
   rocket: its +x_mult grows on SKIPPED boss blinds and this build has no skip phase (78698: sat at x1 all run) */
/* obelisk IN (user-confirmed text 10-29): X0.2/hand only for hands that are NOT our
   most-played family and resets to X1 the moment that family is played - a permanent
   X1 for our single-family grind (deep runs bought it on tier and got nothing).
   loyalty card OUT of junk (10-29): it DOES fire here - X4 on every 6th hand, live
   loyalty_remaining counter verified in selftest; 10-13 "never fires" note was wrong */
const JUNK_JOKER = /half joker|credit card|burglar|fortune teller|business card|red card|droll joker|sly joker|wily joker|devious joker|crafty joker|square joker|madness|rocket|obelisk|^the joker$/i;
/* Re-tiered 10-30 against the measured deep-run lift census (full-5-joker boards,
   n=493 complete runs, base deep-rate 0.28): promote scaling names with the highest
   deep share - Spare Trousers .63, Abstract .58 (already in), Fibonacci .58 (in),
   Castle .38, Card Sharp .42; demote measured-down names Bull .11, Faceless .12,
   Ice Cream .09 (decay/consumable items plateau at a3+) to neutral. Vanilla intuition
   put all six the wrong way. */
const STRONG_JOKER = /blueprint|brainstorm|the duo|the trio|the family|the house|the mark|the lumberjack|majestic|merry|sock|even steven|mystic|alt|banner|abstract|mime|hologram|chicot|canio|triboulet|yorick|supernova|constellation|green joker|vampire|hit the road|the half|buster|smeared|ramen|fibonacci|pareidolia|séance|vagabond|\bmad\b|popsicle|ride the bus|runner|diet cola|splash|nebula|ghost|dad|stuntman|walkie|cerb|blue joker|gray joker|chad|sesquipedal|turtle bean|sixth sense|judgment|spirit|uncertainty|invisible|baron|baseball card|photograph|campfire|loyalty card|spare trousers|castle|card sharp/;

/**
 * Classify a joker name into a shop tier.
 *
 * @param {string} name - joker display name (may be empty or missing)
 * @returns {number} 2 when STRONG_JOKER matches, 1 otherwise, 0 when the name is missing
 */
function jokerTier(name) {
    if (!name) {
        return 0;
    }

    return STRONG_JOKER.test(name) ? 2 : 1;
}

export { DIR, OUT, resF, jw, setRunId, say, sleep, tryLoad0, stakeMap, wins, saveWins, saveStakeMap, STAKE_LABELS, policy, setStakeCtx, saveStakeLock, stakeLocks, buildFamilies, jokerFactor, jokerSig, JUNK_JOKER, STRONG_JOKER, jokerTier };
