/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: planet-take match census — does each shop/pack planet buy equal that shop's nf target?
import fs from 'node:fs';

const lines = fs.readFileSync('out/log.jsonl', 'utf8').split('\n');
let match = 0;
let filler = 0;
const fillers = {};
let curNf = null;

for (const s of lines) {
    if (!s.includes('"e":"shopdump"') && !s.includes('"e":"shopdone"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(s);
    } catch {
        continue;
    }

    if (j.e === 'shopdump' && j.pre === 1) {
        curNf = j.nf ?? null;
        continue;
    }

    if (j.e !== 'shopdone' || !Array.isArray(j.actions)) {
        continue;
    }

    for (const a of j.actions.map(String)) {
        if (!(a.startsWith('planet:') || a.startsWith('take:'))) {
            continue;
        }

        const n = a.split(':')[1];

        if (!/Neptune|Uranus|Venus|Saturn|Jupiter|Mars|Mercury|Pluto|Earth|Ceres|Eris/.test(n)) {
            continue;
        }

        if (!curNf) {
            /* pre-nf-era rows carry no target family: not evidence of filler */
            continue;
        }

        if (PLANET_OF(n) === curNf) {
            match += 1;
        } else {
            filler += 1;
            fillers[n] = (fillers[n] ?? 0) + 1;
        }
    }
}

/**
 * Planet name to family.
 *
 * @param {string} n - planet name
 * @returns {string} family label
 */
function PLANET_OF(n) {
    const m = {
        Mercury: 'Pair', Uranus: 'Two Pair', Venus: 'Three of a Kind', Saturn: 'Four of a Kind',
        Jupiter: 'Flush', Earth: 'Full House', Mars: 'Straight', Neptune: 'Straight Flush', Pluto: 'High Card',
    };

    return m[n] ?? '?';
}

console.log('nf-match:', match, 'filler:', filler, 'match%:', Math.round(100 * match / (match + filler)), 'top fillers:', Object.entries(fillers).sort((a, c) => c[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(' '));
