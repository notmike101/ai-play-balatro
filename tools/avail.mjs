/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
/* Availability-split planet-take audit (fixed): for each planet bought since BASE,
   was the focal (nf) planet available — on the shop shelf or inside the opened
   celestial pack — at buy time? misses ONLY count when needed planet present. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { FAM_BY_PLANET } = await import(pathToFileURL('D:/balatro-ai/poker-agent/lib/planets.mjs').href);
const BASE = Number(process.argv[2] || 1793388000000);
const inv = {};
for (const [p, f] of Object.entries(FAM_BY_PLANET)) if (!inv[f]) inv[f] = p;

const tl = {};
let pdCount = 0;
for (const l of fs.readFileSync('D:/balatro-ai/poker-agent/out/log.jsonl', 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j || typeof j.ts !== 'number' || j.ts < BASE || !j.rid) continue;
    const r = tl[j.rid] ??= { nf: null, shelf: [], packs: [] };
    if (j.e === 'shopdump' && j.pre === 1) { r.nf = j.nf; r.shelf = (j.items || []).map((x) => x.n); } else if (j.e === 'packdump') {
        const planets = (j.items || []).filter((x) => x.k === 'Planet').map((x) => x.n);
        if (planets.length) { pdCount++; r.packs.push(planets); }
    } else if (j.e === 'shopdone' && Array.isArray(j.actions)) {
        for (const a of j.actions) {
            if (!/^take:/.test(a)) continue;
            const p = a.slice(5);
            if (!(p in FAM_BY_PLANET)) continue;
            r.takes ??= []; r.takes.push({ p, nf: r.nf, shelf: r.shelf, packs: r.packs });
        }
    }
}

let matched = 0; let missAvail = 0; let filler = 0; let unknown = 0;
for (const [rid, r] of Object.entries(tl)) for (const t of r.takes ?? []) {
    const need = inv[t.nf];
    if (!need) { unknown++; continue; }
    const avail = t.shelf.includes(need) || t.packs.some((list) => list.includes(need));
    if (t.p === need) { matched++; continue; }
    if (avail) { missAvail++; console.log(`MISS rid ${rid} nf=${t.nf} need=${need} bought=${t.p} shelf=[${t.shelf}] packs=${JSON.stringify(t.packs)}`); } else filler++;
}

console.log(`packdumps-with-planets=${pdCount} takes: matched=${matched} realMisses=${missAvail} supplyForced=${filler} nfUnknown=${unknown}`);
