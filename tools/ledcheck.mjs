/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: per-shop true-ledger flip replay from shopdump hb snapshots (post-deploy runs).
import { buildFamilies } from '../lib/knowledge.mjs';
import { PLANET_GRIND } from '../lib/planets.mjs';
import fs from 'node:fs';

const fams = buildFamilies();

/**
 * Play-max family under old (grind-only) or new (incl FH>=4) filter.
 *
 * @param {number[][]} hb - [[name, level, played]]
 * @param {boolean} strict - old rule
 * @returns {[string, number] | null} fam/plays
 */
function ledOf(hb, strict) {
    const rows = fams.map((f) => {
        const r = hb.find((x) => x[0] === f);

        return { f, lvl: r?.[1] ?? 1, played: r?.[2] ?? 0 };
    }).filter((r) => r.lvl < 9 && (PLANET_GRIND.has(r.f) || (!strict && r.f === 'Full House' && r.played >= 4)));
    const max = Math.max(0, ...rows.map((r) => r.played));

    if (!max) {
        return null;
    }

    return [rows.filter((r) => r.played === max).sort((a, b) => fams.indexOf(a.f) - fams.indexOf(b.f))[0].f, max];
}

let n = 0;
let misses = 0;

for (const s of fs.readFileSync('out/log.jsonl', 'utf8').split('\n')) {
    if (!s.includes('"e":"shopdump"') || !s.includes('"hb"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(s);
    } catch {
        continue;
    }

    if (!Array.isArray(j.hb) || j.nf === undefined) {
        continue;
    }

    n += 1;
    const cur = j.hb.find((x) => x[0] === j.nf)?.[2] ?? 0;
    const nw = ledOf(j.hb, false);
    const old = ledOf(j.hb, true);
    const newFlip = nw && nw[0] !== j.nf && nw[1] >= 3 && nw[1] + 1 >= cur;
    const oldFlip = old && old[0] !== j.nf && old[1] >= 3 && old[1] >= cur;

    if (newFlip) {
        misses += 1;
        console.log(`a${j.ante} nf=${j.nf} -> ${nw[0]}/${nw[1]} (cur ${j.nf}/${cur})${oldFlip ? ' OLD-ALSO' : ' OLD-MISSED'}`);
    }
}

console.log(`shops=${n} missed-flip-now-fires=${misses}`);
