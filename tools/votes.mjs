/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
/* votes.mjs — focal-capture audit over gamefam rows (game-attested level-ups).
   Shop buys (via=buy1/buy2 = the item's OWN boost, never held-consumable uses, which
   carry no n/name) join the nearest PRE shopdump; pack takes join the nearest packdump.
   Known false-positive mode (1793347123): BOTH planets bought as HELD items, nf flipped
   between shelf rows, game boosted the held-slot-first planet before the nf one — the
   second planet still lands later in the same blind. Treat 1-2 misses with via=buyN and
   the wanted planet ALSO bought in the same actions row as benign. */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const db = new DatabaseSync(fileURLToPath(new URL('../out/runs.db', import.meta.url)), { readOnly: true });
const PN = { Pair: 'Mercury', 'Two Pair': 'Uranus', 'Three of a Kind': 'Venus', Straight: 'Saturn', Flush: 'Jupiter', 'Full House': 'Earth', 'Four of a Kind': 'Mars', 'High Card': 'Pluto', 'Straight Flush': 'Neptune' };
const rows = db.prepare('SELECT g.ts,g.rid,g.n,g.gamefam gf,g.via via,(SELECT s.nf FROM shopdump s WHERE s.rid=g.rid AND s.pre=1 AND s.ts<=g.ts ORDER BY s.ts DESC LIMIT 1) nf FROM gamefam g WHERE g.gamefam<>\'\'').all();
let miss = 0, nf = 0, forced = 0, nojoin = 0;
for (const r of rows) {
    if (!r.nf) { nojoin++; continue; }
    if (r.gf === r.nf) { nf++; continue; }
    const want = PN[r.nf];
    if (!want) { forced++; continue; }
    let off = false;
    if (String(r.via).startsWith('pack')) {
        const p = db.prepare('SELECT items FROM packdump WHERE rid=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(r.rid, r.ts);
        if (p) { try { off = (JSON.parse(p.items) || []).some((i) => i.n === want); } catch { /* skip */ } }
    } else {
        const sh = db.prepare('SELECT items FROM shopdump WHERE rid=? AND pre=1 AND ts<=? ORDER BY ts DESC LIMIT 1').get(r.rid, r.ts);
        if (sh) { try { off = (JSON.parse(sh.items) || []).some((i) => i.n === want && String(i.k).toLowerCase() === 'planet'); } catch { /* skip */ } }
    }
    if (off) { miss++; console.log('MISS', r.rid, r.ts, `nf=${r.nf}`, 'want', want, 'took', r.n, r.via); } else forced++;
}
console.log('votes', rows.length, '| nf-matched', nf, '| supply-forced', forced, '| MISSES', miss, '| no-nf-join', nojoin);
