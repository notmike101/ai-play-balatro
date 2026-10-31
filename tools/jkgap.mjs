/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: corpus pred-vs-actual ratio by joker-count cohort and ante; is the model blind to engine multipliers?
import fs from 'node:fs';

const digests = fs.readFileSync('out/digests.jsonl', 'utf8').trim().split('\n').map((s) => JSON.parse(s)).filter((d) => d.complete && d.t);
const byRid = new Map(digests.map((d) => [d.rid, d]));
const rows = [];

for (const s of fs.readFileSync('out/log.jsonl', 'utf8').split('\n')) {
    if (!s.includes('"e":"decide"') || !s.includes('"pred"') || !s.includes('"rchips"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(s);
    } catch {
        continue;
    }

    const d = byRid.get(j.rid);

    if (!d || !(j.pred > 0) || !(j.rchips > 0)) {
        continue;
    }

    rows.push({ ratio: j.rchips / j.pred, ante: d.ante, jk: d.jokers ?? 0 });
}

/**
 * Median/p10 of ratios in a cohort.
 *
 * @param {number[]} v - ratios
 * @returns {string} formatted stats
 */
function q(v) {
    if (!v.length) {
        return '-';
    }

    const a = v.slice().sort((x, c) => x - c);
    /**
     * Percentile of sorted array.
     *
     * @param {number} f - fraction 0-1
     * @returns {string} value
     */
    const p = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(2);

    return `n=${a.length} med=${p(0.5)} p10=${p(0.1)} p90=${p(0.9)}`;
}

for (const jk of [0, 1, 2, 3, 4, 5]) {
    const v = rows.filter((r) => r.jk === jk && r.ante >= 4).map((r) => r.ratio);

    console.log(`jk=${jk} a4+: ${q(v)}`);
}

for (const a of [1, 2, 3, 4, 5, 6]) {
    const v = rows.filter((r) => r.ante === a && r.jk >= 4).map((r) => r.ratio);

    console.log(`a${a} jk4+: ${q(v)}`);
}
