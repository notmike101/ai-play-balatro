/* tools/cohort.mjs — ONE-SHOT policy-epoch readout from out/runs.db (run tools/dbimport.mjs first).
   Prints every deploy epoch (from the deploy table) with its cohort's run stats side by side,
   so cohort comparisons no longer need manual t-threshold bookkeeping. Optional arg: number of
   epochs to show (default 6). Per-epoch: n / avgA / wins / final-depth hist / a1-a2 share /
   focal-L1@death(a>2) / board-full / celestial share / near-miss(<1500) share / flip rows. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DIR = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const db = new DatabaseSync(path.join(DIR, 'out', 'runs.db'), { readOnly: true });
const N = Number(process.argv[2] ?? 6);

const dep = db.prepare('SELECT sha, ts FROM deploy ORDER BY ts DESC LIMIT ?').all(N).reverse();
console.log('epochs (commit time; runs counted = digest t in [epoch, next epoch)):');
for (let i = 0; i < dep.length; i++) {
    const lo = dep[i].ts;
    const hi = i + 1 < dep.length ? dep[i + 1].ts : 9e15;
    const rs = db.prepare('SELECT rid, m, w FROM runmax WHERE t0>=? AND t0<?').all(lo, hi);
    const n = rs.length;
    const avgA = n ? (rs.reduce((a, r) => a + r.m, 0) / n).toFixed(2) : '-';
    const wins = rs.reduce((a, r) => a + r.w, 0);
    const hist = {};
    for (const r of rs) hist[r.m] = (hist[r.m] || 0) + 1;
    const dd = db.prepare('SELECT focalLvl fl, ante a, jokers j, celestial c, gap g, t FROM rundigest WHERE t>=? AND t<?').all(lo, hi);
    const a2p = dd.filter((r) => r.a > 2);
    const l1 = a2p.filter((r) => r.fl === 1).length;
    const full = dd.filter((r) => r.j >= 5).length;
    const cel = dd.filter((r) => r.c === 1).length;
    const near = dd.filter((r) => r.g !== null && r.g < 1500).length;
    const gated = db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND body LIKE \'%"gated":1%\' AND ts>=? AND ts<?').get(lo, hi).c;
    const fm = db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND body LIKE \'%"shelfHasWant":1%\' AND ts>=? AND ts<?').get(lo, hi).c;
    console.log(
        `${dep[i].sha.slice(0, 7)} n=${String(n).padStart(3)} avgA=${String(avgA).padStart(4)} w=${wins}`
        + ` hist=${JSON.stringify(hist)}`
        + ` L1@death(a>2)=${l1}/${a2p.length} full5=${n ? Math.round(100 * full / dd.length) : 0}% cel=${n ? Math.round(100 * cel / dd.length) : 0}%`
        + ` near<1.5k=${near}/${dd.length} flips=${db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND ts>=? AND ts<?').get(lo, hi).c}(want=${fm} gated=${gated})${i === dep.length - 1 ? '   <-- CURRENT' : ''}`,
    );
}
