/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: what separates deep runs from the a1-a3 majority? aggregate digests + boss-of-death census.
import fs from 'node:fs';

const digs = fs.readFileSync('out/digests.jsonl', 'utf8').split('\n').filter((s) => s.trim()).map((s) => JSON.parse(s));
const full = digs.filter((d) => d.complete);
const buckets = [[1, 3], [4, 4], [5, 5], [6, 8]];
/**
 * Mean of a numeric array.
 *
 * @param {number[]} a - numbers
 * @returns {number} mean
 */
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log(`n=${full.length}`);

for (const [lo, hi] of buckets) {
    const g = full.filter((d) => d.ante >= lo && d.ante <= hi);

    if (!g.length) {
        continue;
    }

    const foc = {};

    for (const d of g) {
        foc[d.focal ?? '?'] = (foc[d.focal ?? '?'] ?? 0) + 1;
    }

    const topF = Object.entries(foc).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${Math.round(100 * v / g.length)}%`).join(' ');

    console.log(
        `a${lo === hi ? lo : `${lo}-${hi}`} n=${g.length} (${Math.round(100 * g.length / full.length)}%) lvlAct=${mean(g.map((d) => d.lvlAct)).toFixed(1)} focalLvl=${mean(g.map((d) => d.focalLvl ?? 0)).toFixed(1)} jokers=${mean(g.map((d) => d.jokers)).toFixed(1)} rerolls=${mean(g.map((d) => d.rerolls)).toFixed(1)} cel=${Math.round(100 * g.filter((d) => d.celestial).length / g.length)}% focalPlays=${mean(g.map((d) => d.focalPlays)).toFixed(0)} | ${topF}`,
    );
}

// boss-of-death for runs that fell at ante>=4
const bossOf = {};
const rl = new Set(full.filter((d) => d.ante >= 4).map((d) => String(d.rid)));

const lines = fs.readFileSync('out/log.jsonl', 'utf8').split('\n');

for (const s of lines) {
    if (!s.includes('"e":"blind"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(s);
    } catch {
        continue;
    }

    if (j.e !== 'blind' || !rl.has(String(j.rid))) {
        continue;
    }

    const pend = String(j.name ?? '').split(',').find((p) => p.endsWith(':Select'));
    const b = pend ? pend.split(':')[0] : '?';
    const k = `${j.ante}|${b}`;

    bossOf[k] = (bossOf[k] ?? 0) + 1;
}

console.log('--- deepest pending Select per run (a4+ deaths): ante|boss -> count');
const rows = Object.entries(bossOf).sort((a, b) => a[0].localeCompare(b[0]));
const byAnte = {};

for (const [k, v] of rows) {
    (byAnte[k.split('|')[0]] ??= []).push(`${k.split('|')[1]}:${v}`);
}

for (const [a, list] of Object.entries(byAnte)) {
    console.log(`ante${a}  ${list.join(' ')}`);
}
