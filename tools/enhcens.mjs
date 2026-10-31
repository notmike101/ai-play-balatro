/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
/* enhancement effect on pred ratio: turn rows carry per-card enh keys; decide rows carry enh counts.
   group same-blind play gains (ordplay method) by whether played cards had enhancements. */
import fs from 'node:fs';

const rows = [];
for (const s of fs.readFileSync('out/log.jsonl', 'utf8').split('\n')) {
    if (!s.includes('"e":"turn"') && !s.includes('"e":"decide"')) continue;
    try {
        const j = JSON.parse(s);
        if (j && j.ts) rows.push(j);
    } catch { /* not JSON */ }
}
rows.sort((a, b) => a.ts - b.ts);
const keys = {};
for (const t of rows) if (t.e === 'turn' && Array.isArray(t.hand)) for (const h of t.hand) { const k = h[6] || ''; if (k) keys[k] = (keys[k] || 0) + 1; }
console.log('enh-ish card keys in hands:', JSON.stringify(keys));
// ratio cohort: decide play row -> gain = next decide/blind rchips delta or turn chips delta; use turn-row chips deltas like ordplay
const gain = [];
for (let i = 1; i < rows.length - 1; i++) {
    const d = rows[i];
    if (d.e !== 'decide' || d.a !== 'play' || !d.rchips) continue;
    // next decide same rid: gain = its rchips minus mine (rchips is PRE-play of that row)
    const nx = rows.slice(i + 1, i + 4).find((r) => r.e === 'decide' && r.rid === d.rid && r.rchips);
    if (!nx || nx.rchips <= d.rchips) continue;
    const ehs = d.enh || 0;
    gain.push([ehs, d.pred, nx.rchips - d.rchips]);
}
const bucket = {};
for (const [e, pred, g] of gain) {
    if (!pred || g == null || g <= 0) continue;
    const k = e === 0 ? 'none' : String(e);
    (bucket[k] ??= []).push(g / pred);
}
for (const [k, v] of Object.entries(bucket)) {
    v.sort((a, b) => a - b);
    console.log('enh-count', k, `n=${v.length}`, 'p25', v[Math.floor(v.length * 0.25)]?.toFixed(2), 'p50', v[Math.floor(v.length / 2)]?.toFixed(2), 'p75', v[Math.floor(v.length * 0.75)]?.toFixed(2));
}
