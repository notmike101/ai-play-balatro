/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// per-shop join: focal planet on pre=1 shelf -> did THIS shop's shopdone buy it?
import fs from 'node:fs';
const rows = [];
for (const s of fs.readFileSync('out/log.jsonl', 'utf8').split('\n')) {
    try {
        const j = JSON.parse(s);
        if (j && j.ts && (j.e === 'shopdump' || j.e === 'shopdone')) rows.push(j);
    } catch { /* not JSON */ }
}
rows.sort((a, b) => a.ts - b.ts);
const PN = { Pair: 'Mercury', 'Two Pair': 'Uranus', 'Three of a Kind': 'Venus', Straight: 'Saturn', Flush: 'Jupiter', 'Full House': 'Earth', 'Four of a Kind': 'Mars' };
let onShelf = 0;
let bought = 0;
const poor = [];
const misses = [];
const anteCnt = {};
for (let i = 0; i < rows.length; i++) {
    const d = rows[i];
    if (d.e !== 'shopdump' || d.pre !== 1 || !d.nf) continue;
    const pl = PN[d.nf];
    if (!pl) continue;
    const item = (d.items || []).find((it) => it.n === pl && String(it.k || '').toLowerCase() === 'planet' && (it.a || []).includes('buy'));
    if (!item) continue;
    onShelf++;
    const a = d.ante ?? '?';
    const b = (anteCnt[a] ??= [0, 0]);
    b[0]++;
    // next shopdone same rid
    let sd = null;
    for (let k = i + 1; k < rows.length && rows[k].ts - d.ts < 60000; k++) if (rows[k].e === 'shopdone' && rows[k].rid === d.rid) { sd = rows[k]; break; }
    if (sd && Array.isArray(sd.actions) && sd.actions.includes(`planet:${pl}`)) { bought++; continue; }
    if (b) b[1]++;
    if ((sd?.money ?? d.money ?? 0) + 0 < (item.c ?? 5) && (d.money ?? 0) < (item.c ?? 5)) poor.push(d.rid);
    else misses.push({ rid: d.rid, ante: a, cost: item.c, money: d.money, got: sd ? sd.actions.filter((x) => /planet|pack/.test(x)).join('+') : 'no-shopdone' });
}
console.log('focal planet on shelf (pre=1, nf match):', onShelf, '| bought same shop:', bought, '(', (100 * bought / Math.max(1, onShelf)).toFixed(0), '%)');
console.log('by ante (shelf,miss):', JSON.stringify(anteCnt));
console.log('money-locked (could not afford):', poor.length);
console.log('true misses (affordable, skipped):', misses.length);
for (const m of misses.slice(0, 15)) console.log(' miss', JSON.stringify(m));
