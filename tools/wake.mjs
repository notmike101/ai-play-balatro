/* tools/wake.mjs — ONE wake-cycle readout: runs dbimport, tallies the newest policy eras
   straight from the deploy table (no hand-copied dep ts / no SQL in bash -e), counts the
   pre-registered watches (High-Card focal strikes, planet-use proof, wins), and prints the
   newest digest ts on the LAST line so the wake chain is exactly:
       T=$(node tools/wake.mjs | tail -1) && WATCH_N=4 node tools/watchrun.mjs "$T"
   Zero behavior; derived data only. */
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const DIR = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));

execFileSync(process.execPath, [path.join(DIR, 'tools', 'dbimport.mjs')], { cwd: DIR, stdio: 'pipe' });

const db = new DatabaseSync(path.join(DIR, 'out', 'runs.db'), { readOnly: true });

const LOG_LINES = fs.readFileSync(path.join(DIR, 'out', 'log.jsonl'), 'utf8').trim().split('\n');
const SESSIONS = [];

for (const l of LOG_LINES) {
    if (l.includes('"sessionstart"')) {
        try {
            SESSIONS.push(JSON.parse(l).ts);
        } catch { /* skip malformed */ }
    }
}
SESSIONS.sort((a, b) => a - b);

/**
 * Code-LIVE time for a commit ts: the driver boots from the working tree, so the first
 * sessionstart at-or-after (commit - 90s) - a boot seconds BEFORE the commit already has
 * the change (commit-lag), and a restart still mid-page-reconnect lands later. Era tallies
 * anchored here stop counting old-code runs from the boundary window.
 *
 * @param {number} ts - commit ts of the code-change boundary
 * @returns {number} live ts
 */
function liveAt(ts) {
    const s = SESSIONS.find((t) => t >= ts - 90000);

    return s && s > ts ? s : ts;
}

/**
 * Deploy rows filtered to POLICY-CODE changes: deploy rows are SYNTHESIZED by dbimport from
 * every git commit, so without this filter docs/tools commits shatter every cohort window
 * into fragments (a non-code commit neither changes behavior nor, by itself, restarts the
 * driver - the working tree is the deploy; restarts happen when the driver exits).
 *
 * @returns {Array<{sha: string, ts: number}>} code-change boundaries, newest first
 */
function codeEras() {
    const dep = db.prepare('SELECT sha, ts FROM deploy ORDER BY ts').all();
    const keep = [];

    for (const d of dep) {
        if (!keep.length) {
            keep.push(d);
            continue;
        }

        const prev = keep[keep.length - 1];
        const r = spawnSync('git', ['diff', '--quiet', prev.sha, d.sha, '--', 'lib', 'driver.mjs'], { cwd: DIR });

        if (r.status !== 0) {
            keep.push(d);
        }
    }

    return keep.reverse();
}

/**
 * Per-era tallies for the last `k` policy-code windows [ts_i, ts_{i+1}).
 *
 * @param {number} k - number of eras to print
 * @returns {void} prints one row per era
 */
function eras(k) {
    const dep = codeEras().slice(0, k);

    for (const [i, d] of dep.entries()) {
        const hi = i > 0 ? liveAt(dep[i - 1].ts) : null;
        const lo = liveAt(d.ts);
        const q = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(ante),2) a, SUM(CASE WHEN gap<2500 THEN 1 ELSE 0 END) nm, SUM(ante>=5) d5, SUM(won) w, SUM(CASE WHEN celestial=0 THEN 1 ELSE 0 END) dry FROM rundigest WHERE complete=1 AND t>=?${hi ? ' AND t<?' : ''}`);
        const r = (hi ? q.all(lo, hi) : q.all(lo))[0];
        const hc = (db.prepare(`SELECT COUNT(*) c FROM rundigest WHERE complete=1 AND focal='High Card' AND focalLvl<=2 AND ante>=3 AND t>=?${hi ? ' AND t<?' : ''}`).all(...(hi ? [lo, hi] : [lo]))[0]).c;

        console.log(`${d.sha.slice(0, 7)} @${lo} n=${r.n} avgA=${r.a} near-miss=${r.nm} a5+=${r.d5} WINS=${r.w} dry=${r.dry} HCstrike=${hc}/3`);
    }
}

/**
 * Planet use-on-sight proof: consuse rows naming a planet since the newest deploy.
 *
 * @returns {void} prints the count
 */
function planetProof() {
    const ts = liveAt((codeEras()[0] || {}).ts || 0);
    const PN = /^(mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)$/i;
    let u = 0;

    for (const l of LOG_LINES) {
        if (!l.includes('"consuse"')) {
            continue;
        }

        try {
            const r = JSON.parse(l);

            if (r.ts >= ts && PN.test(String(r.name || '').toLowerCase())) {
                u++;
            }
        } catch { /* skip malformed */ }
    }

    console.log(`planet-uses since newest deploy: ${u}`);
}

eras(3);
planetProof();
const lines = fs.readFileSync(path.join(DIR, 'out', 'digests.jsonl'), 'utf8').trim().split('\n');

console.log(lines[lines.length - 1] ? JSON.parse(lines[lines.length - 1]).t : Date.now());
