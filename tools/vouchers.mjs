#!/usr/bin/env node
/* COHORT-12 metric: supply-voucher economics between deploy SHAs (or --since ts).
   usage: node tools/vouchers.mjs --since <ts>|--sha <prefix> [--until <ts>] */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const db = new DatabaseSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'out', 'runs.db'), { readOnly: true });
const argv = process.argv.slice(2);

/**
 * Reads a CLI flag value: the token immediately after the given flag.
 *
 * @param {string} k - flag token (e.g. '--rid')
 *
 * @returns {string|null} flag value or null when absent
 */
function arg(k) {
    const i = argv.indexOf(k);

    return i !== -1 ? argv[i + 1] : null;
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
const COST = /"k":"Voucher"[^}]*"n":"(Planet Merchant|Telescope)"|"n":"(Planet Merchant|Telescope)"[^}]*"k":"Voucher"/;
const shops = db.prepare('SELECT ts, rid, ante, money, items FROM shopdump WHERE pre=1 AND ts BETWEEN ? AND ?').all(since, until);
const stockedRuns = new Set();
const buyRuns = new Set();
let stocked = 0;
let afforded = 0;

for (const s of shops) {
    if (!COST.test(s.items)) {
        continue;
    }

    stocked++;
    stockedRuns.add(s.rid);

    if (s.money >= 10) {
        afforded++;
    }
}

const sd = db.prepare('SELECT rid, actions FROM shopdone WHERE ts BETWEEN ? AND ?').all(since, until);
let buys = 0;

for (const r of sd) {
    if (/voucher:(Planet Merchant|Telescope)/.test(r.actions)) {
        buys++;
        buyRuns.add(r.rid);
    }
}

const runs = db.prepare('SELECT COUNT(DISTINCT rid) c FROM rundigest WHERE t BETWEEN ? AND ?').get(since, until).c;
const starved = db.prepare('SELECT COUNT(*) c FROM rundigest WHERE t BETWEEN ? AND ? AND lvlAct=0').get(since, until).c;

console.log(JSON.stringify({
    since,
    until,
    runs,
    shops: shops.length,
    pmTelStocked: stocked,
    afforded10: afforded,
    buys,
    runCoveragePct: runs ? Math.round((buyRuns.size / runs) * 100) : null,
    starvedPct: runs ? Math.round((starved / runs) * 100) : null,
}));
