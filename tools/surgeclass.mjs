/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
// throwaway: classify LOW_FOCAL deaths as post-surge (focal never led at shops) vs missed (led, unlevelled).
import { buildFamilies } from '../lib/knowledge.mjs';
import fs from 'node:fs';

const fams = buildFamilies();
const armRid = new Set();

for (const s of fs.readFileSync('out/log.jsonl', 'utf8').split('\n')) {
    if (s.includes('"e":"blind"') && s.includes('The Arm')) {
        try {
            const j = JSON.parse(s);

            armRid.add(j.rid);
        } catch {
            /* unparsable row */
        }
    }
}

const digests = fs.readFileSync('out/digests.jsonl', 'utf8').trim().split('\n').map((s) => JSON.parse(s)).filter((d) => d.complete && d.t && d.won === false);
const FAM_PL = { Pair: 'Mercury', 'Two Pair': 'Uranus', 'Three of a Kind': 'Venus', Straight: 'Mars', Flush: 'Jupiter', 'Full House': 'Earth', 'Four of a Kind': 'Pluto', 'Straight Flush': 'Neptune' };
const shopsByRid = new Map();

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

    if (!Array.isArray(j.hb)) {
        continue;
    }

    if (!shopsByRid.has(j.rid)) {
        shopsByRid.set(j.rid, []);
    }

    shopsByRid.get(j.rid).push(j);
}

let postSurge = 0;
let missed = 0;
let starved = 0;
let ok = 0;
let noData = 0;
const missedRids = [];
const starveRids = [];

for (const d of digests.slice(-60)) {
    const shops = shopsByRid.get(d.rid);

    if (!shops || !shops.length) {
        noData += 1;
        continue;
    }

    let everLed = 0;
    let supply = 0;

    for (const sh of shops) {
        const fp = FAM_PL[d.focal] ?? '';

        if ((sh.items || []).some((it) => it.k === 'Planet' && it.n === fp && (it.a || []).includes('buy') && (sh.money ?? 0) >= (it.c ?? 4) + 1)) {
            supply += 1;
        }

        const rows = fams.map((f) => {
            const r = sh.hb.find((x) => x[0] === f);

            return { f, played: r?.[2] ?? 0, lvl: r?.[1] ?? 1 };
        });
        const focalRow = rows.find((r) => r.f === d.focal);
        const others = rows.filter((r) => r.f !== d.focal).map((r) => r.played);
        const maxOther = others.length ? Math.max(...others) : 0;

        if (focalRow && focalRow.played >= 3 && focalRow.played >= maxOther) {
            everLed += 1;
        }
    }

    /* The Arm knocks the played fam's level post-scoring; digest snapshots are
       post-Arm so runs ending under Arm understate the level the build earned */
    const focalLvl = (d.focalLvl ?? 1) + (armRid.has(d.rid) ? 1 : 0);
    const want = 1 + Math.floor((d.focalPlays ?? 0) / 4);

    if (focalLvl >= want) {
        ok += 1;
    } else if (everLed >= 2 && supply > 0) {
        missed += 1;
        missedRids.push(`${d.rid}(${d.focal}/${d.focalPlays}L${focalLvl} led@${everLed} SUPPLY@${supply})`);
    } else if (everLed >= 2) {
        starved += 1;
        starveRids.push(`${d.rid}(${d.focal} led@${everLed} shelf0)`);
    } else {
        postSurge += 1;
    }
}

console.log(`recent=${noData + postSurge + missed + starved + ok} noHb=${noData} focal-levelled=${ok} post-surge=${postSurge} supply-starved=${starved} missed-while-led-and-shelved=${missed}`, missedRids.join(' '), '|', starveRids.join(' '));
