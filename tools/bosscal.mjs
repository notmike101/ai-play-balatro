/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: per-boss prediction calibration from decide rows (actual = rchips delta within same blind)
import fs from 'node:fs';

const lines = fs.readFileSync('out/log.jsonl', 'utf8').split('\n');
const per = {};
let key = '';
let prevC = null;

for (const s of lines) {
    if (!s.includes('"e":"decide"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(s);
    } catch {
        continue;
    }

    if (j.e !== 'decide') {
        continue;
    }

    const k = `${j.rid}|${j.tgt ?? 0}|${j.b ?? ''}`;

    if (j.a === 'play' && j.pred > 0 && typeof j.rchips === 'number' && k === key && prevC !== null) {
        const gain = j.rchips - prevC;
        const ratio = gain / j.pred;

        if (gain > 0 && ratio <= 30) {
            (per[j.b ?? '?'] ??= []).push(ratio);
        }
    }

    if (typeof j.rchips === 'number') {
        prevC = k === key ? j.rchips : (key = k, j.rchips);
    }
}

console.log('blind | n | med actual/pred | p10 | p90 (overpredictions <0.7x = model blind spots)');

for (const [b, arr] of Object.entries(per).sort((a, c) => c[1].length - a[1].length).slice(0, 24)) {
    arr.sort((x, y) => x - y);
    /**
     * Quantile of the sorted ratios array.
     *
     * @param {number} p - quantile in [0,1)
     * @returns {number} ratio at that quantile
     */
    const q = (p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const under = arr.filter((x) => x < 0.7).length;

    console.log(`${b} n=${arr.length} med=${q(0.5).toFixed(2)} p10=${q(0.1).toFixed(2)} p90=${q(0.9).toFixed(2)} under70=${Math.round(100 * under / arr.length)}%`);
}
