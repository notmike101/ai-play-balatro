#!/usr/bin/env node
/* COHORT-13 metric: copier (Blueprint/Crafty/Brainstorm) keep-rate between deploy ts.
   prints buys, sells, sell-rate-after-buy, runs holding a copier at their FINAL blind
   (proxy for "held at death board") split by ante>=4, plus a5+ reach + avgA context.
   usage: node tools/copiers.mjs --since <ts>|--sha <prefix> [--until <ts>] */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const db = new DatabaseSync(path.join(ROOT, 'out', 'runs.db'), { readOnly: true });
const argv = process.argv.slice(2);

function arg(k) {
    const i = argv.indexOf(k);

    return i >= 0 ? argv[i + 1] : null;
}

let since = Number(arg('--since'));

if (!since) {
    const row = db.prepare('SELECT ts FROM deploy WHERE sha LIKE ?').get(`${arg('--sha')}%`);

    if (!row) {
        console.error('no deploy row');
        process.exit(1);
    }
    since = row.ts;
}

const until = Number(arg('--until')) || Number.MAX_SAFE_INTEGER;
const CO = /blueprint|crafty|brainstorm/i;
const sd = db.prepare('SELECT rid, actions FROM shopdone WHERE ts BETWEEN ? AND ?').all(since, until);
let buys = 0;
let sells = 0;

for (const r of sd) {
    for (const m of r.actions.matchAll(/(joker|sell):(Blueprint[^",]*|Crafty[^",]*|Brainstorm[^","]*)/g)) {
        if (m[1] === 'sell') {
            sells++;
        } else {
            buys++;
        }
    }
}

/* final-blind joker boards per rid straight from log.jsonl (blind rows carry names) */
const lastBoard = {};
const lines = fs.readFileSync(path.join(ROOT, 'out', 'log.jsonl'), 'utf8').trim().split('\n');

for (const l of lines) {
    let r;

    try {
        r = JSON.parse(l);
    } catch {
        continue;
    }
    if (r.e === 'blind' && r.rid && r.ts >= since && r.ts <= until && Array.isArray(r.jokers)) {
        lastBoard[r.rid] = r.jokers;
    }
}

const runs = db.prepare('SELECT rid, ante FROM rundigest WHERE t BETWEEN ? AND ?').all(since, until);
let held4 = 0;
let heldAny = 0;

for (const [rid, jk] of Object.entries(lastBoard)) {
    if (jk.some((j) => CO.test(j))) {
        heldAny++;
        const rd = runs.find((x) => String(x.rid) === rid);

        if (rd && rd.ante >= 4) {
            held4++;
        }
    }
}

const ctx = db.prepare('SELECT COUNT(*) n, AVG(ante) avgA, SUM(CASE WHEN ante>=5 THEN 1 ELSE 0 END) a5 FROM rundigest WHERE t BETWEEN ? AND ?').get(since, until);

console.log(JSON.stringify({
    since,
    until,
    n: ctx.n,
    avgA: Number((ctx.avgA ?? 0).toFixed(2)),
    a5pct: ctx.n ? Math.round((ctx.a5 / ctx.n) * 100) : null,
    copierBuys: buys,
    copierSells: sells,
    sellRate: buys ? `${sells}/${buys}` : 'n/a',
    runsHoldingCopierAtFinalBlind: heldAny,
    heldAtDeathAnte4plus: held4,
}));
