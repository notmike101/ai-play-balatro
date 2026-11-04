#!/usr/bin/env node
/* supply.mjs — focal-level accumulation + planet shelf-presence per ante.
   Question the a5+/a6 CHIP_GAP wall forces: are deep runs LEVEL-bound by slow
   focal leveling (targeting/lead-time bug we can fix) or by planet APPEARANCE
   rate on shelves (pure supply luck, oracle-free nothing-to-do)? Reads
   shopdump.hb (hands [name,lvl,played] snapshot at each pre-purchase shop)
   joined to rundigest death ante. Usage: node tools/supply.mjs [sinceTs] */
import { DatabaseSync } from 'node:sqlite';
import { FAM_BY_PLANET } from '../lib/planets.mjs';

const since = Number(process.argv[2] ?? 0);
const db = new DatabaseSync(new URL('../out/runs.db', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), { readOnly: true });

/**
 * percentile helper.
 *
 * @param {number[]} a - values
 * @param {number} p - 0-1
 * @returns {number} quantile
 */
const q = (a, p) => {
    if (a.length === 0) {
        return Number.NaN;
    }

    const s = [...a].sort((x, y) => x - y);

    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

const rows = db.prepare(`
    SELECT s.rid, s.ante, s.nf, s.hb, s.items, r.ante AS dead, r.won, r.focal
    FROM shopdump s LEFT JOIN rundigest r ON r.rid = s.rid
    WHERE s.hb IS NOT NULL AND s.pre = 1 AND s.ts >= ?`).all(since);

// per-run per-ante: focal fam = max plays (tie -> higher lvl); focal lvl there.
const perRun = new Map();

for (const row of rows) {
    let hb;
    let items;

    try {
        hb = JSON.parse(row.hb);
        items = JSON.parse(row.items || '[]');
    } catch {
        continue;
    }

    if (!Array.isArray(hb) || hb.length === 0) {
        continue;
    }

    let best = null;

    for (const [name, lvl, played] of hb) {
        if (!(played >= 0)) {
            continue;
        }

        if (!best || played > best.played || (played === best.played && lvl > best.lvl)) {
            best = { name, lvl, played };
        }
    }

    if (!best) {
        continue;
    }

    // was THIS family's planet on this shelf?
    const want = Object.entries(FAM_BY_PLANET).find(([, fam]) => fam === best.name)?.[0];
    const onShelf = want ? items.some((i) => String(i.k || '').toLowerCase() === 'planet' && i.n === want) : false;
    const key = `${row.rid}|${row.ante}`;
    const prev = perRun.get(key);

    if (!prev || best.lvl > prev.lvl) {
        perRun.set(key, { ante: row.ante, lvl: best.lvl, played: best.played, onShelf, dead: row.dead, won: row.won });
    }
}

const byAnte = new Map();

for (const v of [...perRun.values()]) {
    if (v.ante === undefined || v.ante === null || !Number.isInteger(v.ante)) {
        continue;
    }

    const g = byAnte.get(v.ante) ?? { lvls: [], shelf: 0, n: 0, deep: [], w: 0 };

    g.lvls.push(v.lvl);
    g.n += 1;
    g.shelf += v.onShelf ? 1 : 0;
    g.w += v.won === 1 ? 1 : 0;

    if (v.dead >= 5) {
        g.deep.push(v.lvl);
    }

    byAnte.set(v.ante, g);
}

console.log('ante  n   focalLvl p25/50/75  deep(death>=5) p50  planetOnShelf%');

for (const [ante, g] of [...byAnte].sort((a, b) => a[0] - b[0])) {
    if (g.n < 3) {
        continue;
    }

    console.log(`a${ante}\t${g.n}\tlvl ${q(g.lvls, 0.25)}/${q(g.lvls, 0.5)}/${q(g.lvls, 0.75)}\t\t${g.deep.length > 2 ? q(g.deep, 0.5) : '-'}\t\t${(100 * g.shelf / g.n).toFixed(0)}%${g.w > 0 ? ` WINS:${g.w}` : ''}`);
}

// win runs raw traces (the L9-11 target shape)
const wins = db.prepare('SELECT rid, ante, focal, focalLvl FROM rundigest WHERE won = 1').all();

console.log('corpus wins:', wins.length === 0 ? 'none yet' : '');

for (const w of wins.slice(0, 8)) {
    const trace = [...perRun.entries()].filter(([k]) => k.startsWith(`${w.rid}|`)).map(([k, v]) => `a${k.split('|')[1]}:${v.lvl}`).join(' ');

    console.log(`  win rid=${w.rid} died/won a${w.ante} focal=${w.focal} L${w.focalLvl} trace ${trace}`);
}

db.close();
