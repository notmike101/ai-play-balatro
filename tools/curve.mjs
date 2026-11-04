/* tools/curve.mjs — COHORT-19b verdict: catch-up mechanism + a4 attrition split.
   Usage: node tools/curve.mjs <since-ts> [until-ts]
   KPIs (pre-registered 11-04): catchup fires on R<1.1 blind-selects (mechanism rows
   e='curve'); a4 attrition shares vs corpus baseline 26% pre-boss / 33% at-boss /
   36% pass; avgA no-regress vs 3.28. Reads out/runs.db (run tools/dbimport.mjs first). */
import { DatabaseSync } from 'node:sqlite';

const since = Number(process.argv[2]);
const until = Number(process.argv[3] ?? Number.MAX_SAFE_INTEGER);

if (!Number.isFinite(since)) {
    console.error('usage: node tools/curve.mjs <since-ts> [until-ts]');
    process.exit(2);
}

const db = new DatabaseSync('out/runs.db', { readOnly: true });
const hi = until === Number.MAX_SAFE_INTEGER ? 1e18 : until;
/**
 *
 * @param sql
 * @param args
 */
const q = (sql, args = []) => db.prepare(sql).all(...args, since, hi);
const RANGE = 'ts >= ? AND ts <= ?';
/* rundigest mirrors the digest row's own clock column name `t`, everything else `ts` */
const DRANGE = 't >= ? AND t <= ?';

// mechanism: curve rows land in other(e='curve'); body JSON {ante,r,r4,catchup}
const mech = q(`SELECT body b FROM other WHERE e='curve' AND ${RANGE}`)
    .map((x) => JSON.parse(x.b));
const selects = mech.filter((m) => m.ante >= 3 && m.r !== null);
const behind = selects.filter((m) => m.r < 1.1);
const fired = behind.filter((m) => m.catchup === true);

console.log('blind-selects a3+ with R:', selects.length,
    '| R<1.1:', behind.length,
    '| catchup fired:', fired.length, behind.length ? `(${(100 * fired.length / behind.length).toFixed(0)}%)` : '');
const rr = selects.map((m) => m.r).sort((a, b) => a - b);

if (rr.length >= 5) {
    console.log('R dist a3+: p25', rr[Math.floor(rr.length * 0.25)].toFixed(2),
        'p50', rr[Math.floor(rr.length * 0.5)].toFixed(2),
        'p75', rr[Math.floor(rr.length * 0.75)].toFixed(2),
        '| R>=1 share', `${(100 * rr.filter((x) => x >= 1).length / rr.length).toFixed(0)}%`);
}

// attrition + avgA over runs STARTED in the window
const rids = q(`SELECT rid FROM runstart WHERE ${RANGE}`).map((x) => x.rid);
const dig = new Map(q(`SELECT rid, ante FROM rundigest WHERE ${DRANGE}`).map((x) => [x.rid, x.ante]));
const bossSel = new Set(q(`SELECT DISTINCT rid FROM blind WHERE ante=4 AND boss IS NOT NULL AND ${RANGE}`).map((x) => x.rid));
const reached = new Set(q(`SELECT DISTINCT rid FROM blind WHERE ante=4 AND ${RANGE}`).map((x) => x.rid));
const seen = new Set(rids);
let preBoss = 0; let atBoss = 0; let passed = 0; let n = 0;

for (const rid of reached) {
    if (!seen.has(rid)) {
        continue;
    } // run started before window: partial life, exclude

    n++;
    const top = dig.get(rid) ?? 0;

    if (top >= 5) {
        passed++;
    } else if (bossSel.has(rid)) {
        atBoss++;
    } else {
        preBoss++;
    }
}

/**
 *
 * @param x
 */
const p = (x) => `${n ? (100 * x / n).toFixed(0) : '-'}%`;

console.log('a4-reaching runs started in window:', n, '| pre-boss deaths', preBoss, p(preBoss),
    '(base 26%) | at-boss', atBoss, p(atBoss), '(base 33%) | passed a4 boss', passed, p(passed), '(base 36%)');
const ante = q(`SELECT ante FROM rundigest WHERE ${DRANGE} AND complete=1`).map((x) => x.ante);

if (ante.length) {
    const avg = ante.reduce((a, b) => a + b, 0) / ante.length;

    console.log('avgA', avg.toFixed(2), `(n=${ante.length}; baseline 3.28, regress if <2.97)`);
} else {
    console.log('avgA: no complete digests in window yet');
}
