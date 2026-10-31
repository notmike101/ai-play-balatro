/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: focal-planet shelf-vs-buy leak by death-depth bucket; run attribution via ts windows (rid collides across eras)
import fs from 'node:fs';

const F2P = {
    'High Card': 'Pluto', Pair: 'Mercury', 'Two Pair': 'Uranus', 'Three of a Kind': 'Venus',
    'Four of a Kind': 'Saturn', Flush: 'Jupiter', 'Full House': 'Earth', Straight: 'Mars', 'Straight Flush': 'Neptune',
};
const digs = fs.readFileSync('out/digests.jsonl', 'utf8').split('\n').filter((s) => s.trim()).map((s) => JSON.parse(s));
const runs = digs.filter((d) => d.complete && d.t).sort((a, c) => a.t - c.t);

/**
 * Run whose end-window contains ts (digests land at run end).
 *
 * @param {number} ts - row timestamp
 * @returns {object|null} owning run digest or null
 */
function owner(ts) {
    let lo = 0;
    let hi = runs.length - 1;
    let res = null;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;

        if (runs[mid].t >= ts) {
            res = runs[mid];
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    return res;
}

const stat = { a13: [0, 0, 0], a4: [0, 0, 0], a5: [0, 0, 0], a6: [0, 0, 0] };
let cur = null;
const lines = fs.readFileSync('out/log.jsonl', 'utf8').split('\n');

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

    if (typeof j.ts !== 'number') {
        continue;
    }

    const r = owner(j.ts);
    let b = null;

    if (r) {
        if (r.ante >= 6) {
            b = 'a6';
        } else if (r.ante === 5) {
            b = 'a5';
        } else if (r.ante === 4) {
            b = 'a4';
        } else {
            b = 'a13';
        }
    }

    if (j.e === 'shopdump') {
        if (!(j.items || []).length) {
            /* post-purchase reshow: the actionable shelf is the prior non-empty dump */
            continue;
        }

        const planet = r ? F2P[r.focal] : null;
        const shelved = !!planet && (j.items || []).some((it) => it.k === 'Planet' && it.n === planet && (it.a || []).includes('buy'));

        cur = { b, planet, shelved, afford: j.money >= 4, taken: false };

        if (cur.b) {
            stat[cur.b][0] += 1;

            if (cur.shelved && cur.afford) {
                stat[cur.b][1] += 1;
            }
        }

        continue;
    }

    if (cur?.b && cur.shelved && !cur.taken) {
        const acts = (j.actions || []).map(String);

        if (acts.some((a) => (a.startsWith('planet:') || a.startsWith('take:')) && a.split(':')[1] === cur.planet)) {
            cur.taken = true;
            stat[cur.b][2] += 1;
        }
    }
}

console.log('bucket | shops | focalplanet&money>=4 | bought | leak%');

for (const [b, [s, av, bt]] of Object.entries(stat)) {
    console.log(`${b} shops=${s} avail=${av} bought=${bt} leak=${av ? Math.round(100 * (av - bt) / av) : 0}% availPerShop=${s ? (100 * av / s).toFixed(1) : 0}%`);
}
