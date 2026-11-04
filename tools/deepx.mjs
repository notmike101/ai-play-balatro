/* tools/deepx.mjs — share of deep-death runs (ante>=4) whose final blind row showed at
   least one xmult-class joker, using the LIVE classifyJoker table. Baseline 2026-11-01 era
   (19/33 = 58%); cohort-16 (Loyalty xmult fix) soft-gate is >=65%. Reads log.jsonl blind
   rows (the only rows carrying joker NAMES) after a --since ts (arg, default: newest
   code era is NOT auto-derived here - pass the deploy ts explicitly). Prints per-board
   lines for runs WITHOUT xmult plus the summary. Zero behavior; derived data. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const SINCE = Number(process.argv[2] || 0);
const { classifyJoker } = await import(pathToFileURL(path.join(DIR, 'lib', 'jokers.mjs')).href);

const runs = new Map();

for (const l of fs.readFileSync(path.join(DIR, 'out', 'log.jsonl'), 'utf8').trim().split('\n')) {
    if (!l.includes('"e":"blind"')) {
        continue;
    }

    let r;
    try {
        r = JSON.parse(l);
    } catch {
        continue;
    }

    /* positive test: legacy log rows carry NO ts and `undefined < SINCE` is false */
    if (!(r.ts >= SINCE) || !r.jokers?.length) {
        continue;
    }

    const cur = runs.get(r.rid) || { best: 0, board: [] };

    if (r.ante > cur.best || (r.ante === cur.best && r.jokers.length > cur.board.length)) {
        runs.set(r.rid, { best: r.ante, board: r.jokers });
    }
}

let deep = 0;
let withX = 0;

for (const [rid, v] of runs) {
    if (v.best < 4) {
        continue;
    }

    deep++;
    const cats = v.board.map((n) => classifyJoker({ name: n }).cat);

    if (cats.includes('xmult')) {
        withX++;
    } else {
        console.log(`a${v.best} ${rid} ${v.board.join('|')}`);
    }
}

console.log(`deep-death runs ${deep} with >=1 xmult joker ${withX} (${deep ? Math.round(100 * withX / deep) : 0}%)`);
