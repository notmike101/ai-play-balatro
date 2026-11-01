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

/**
 * Deploy rows filtered to POLICY-CODE changes: a push touching no lib//driver.mjs still
 * restarts the driver (loopdrv design) but does NOT start a new measurement era - without
 * this filter docs commits shatter every cohort window into fragments.
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
        const hi = i > 0 ? dep[i - 1].ts : null;
        const q = db.prepare(`SELECT COUNT(*) n, ROUND(AVG(ante),2) a, SUM(CASE WHEN gap<2500 THEN 1 ELSE 0 END) nm, SUM(ante>=5) d5, SUM(won) w, SUM(CASE WHEN celestial=0 THEN 1 ELSE 0 END) dry FROM rundigest WHERE complete=1 AND t>=?${hi ? ' AND t<?' : ''}`);
        const r = (hi ? q.all(d.ts, hi) : q.all(d.ts))[0];
        const hc = (db.prepare(`SELECT COUNT(*) c FROM rundigest WHERE complete=1 AND focal='High Card' AND focalLvl<=2 AND ante>=3 AND t>=?${hi ? ' AND t<?' : ''}`).all(...(hi ? [d.ts, hi] : [d.ts]))[0]).c;

        console.log(`${d.sha.slice(0, 7)} @${d.ts} n=${r.n} avgA=${r.a} near-miss=${r.nm} a5+=${r.d5} WINS=${r.w} dry=${r.dry} HCstrike=${hc}/3`);
    }
}

/**
 * Planet use-on-sight proof: consuse rows naming a planet since the newest deploy.
 *
 * @returns {void} prints the count
 */
function planetProof() {
    const ts = (codeEras()[0] || {}).ts || 0;
    const PN = /^(mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto)$/i;
    const lines = fs.readFileSync(path.join(DIR, 'out', 'log.jsonl'), 'utf8').trim().split('\n');
    let u = 0;

    for (const l of lines) {
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
