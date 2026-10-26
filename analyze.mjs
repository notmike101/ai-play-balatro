/* Out-of-tree run-log analyzer (not part of the driver; excluded from selftest). */
import fs from 'node:fs';

/**
 * Join play decisions with the preceding turn's chips to get actual play scores,
 * carrying context (blind, hand, jokers) from the turn event that preceded each play.
 *
 * @param {object[]} evs - events of ONE rid, sorted by ts ascending
 * @returns {object[]} rows {rid,ts,fam,pred,act,b,dl,hl,hand,jk} for every measurable play
 */
function joinPlays(evs) {
    const rows = [];
    let prev = null;
    let last = null;

    for (const e of evs) {
        if (e.e === 'turn' && typeof e.chips === 'number') {
            prev = e.chips;
            last = e;
        } else if (e.e === 'decide' && e.a === 'play' && typeof e.pred === 'number' && typeof e.rchips === 'number' && prev !== null) {
            const act = e.rchips - prev;

            if (act > 0) {
                rows.push({
                    rid: e.rid, ts: e.ts, fam: e.fam, b: e.b, dl: last?.dl, hl: last?.hl, hand: last?.hand, jk: last?.jk, pred: e.pred, act,
                });
            }
        }
    }

    return rows;
}

/**
 * Compact one-line rendering of an accuracy row with full joker/hand context.
 *
 * @param {object} r - a joinPlays row
 * @returns {string} report line
 */
function fmtRow(r) {
    const q = (r.pred / r.act).toFixed(2);
    const cards = (r.hand || []).map((c) => `${c[1]}${(c[2] || '?')[0]}${c[4] ? '*' : ''}`).join(' ');
    const jk = (r.jk || []).map((j) => {
        const v = j[3];

        return j[0] + (v ? `[m${v.mult || 0}t${v.t_mult || 0}${v.type ? `:${v.type}` : ''}e${typeof v.extra === 'number' ? v.extra : (v.extra && (v.extra.s_mult !== undefined ? `${v.extra.s_mult}/${v.extra.suit}` : JSON.stringify(v.extra))) || 0}${v.x_mult && v.x_mult !== 1 ? `x${v.x_mult}` : ''}]` : '');
    }).join(' ');

    return `  rid ${r.rid} ${r.b}/${r.fam} dl${r.dl} hl${r.hl} pred ${r.pred} act ${r.act} q ${q}\n    hand ${cards}\n    jk ${jk}`;
}

/**
 * Split accuracy rows into over/under prediction extremes, worst first.
 *
 * @param {object[]} rows - joinPlays rows
 * @param {number} [top=8] - cap per side
 * @returns {{over: object[], under: object[]}} q>2 and q<0.5 rows sorted by extremity
 */
/**
 * Prediction-over-actual quotient for an accuracy row.
 *
 * @param {object} r - joinPlays row
 * @returns {number} pred/act
 */
function qOf(r) {
    return r.pred / r.act;
}

/**
 * Split accuracy rows into over/under prediction extremes, worst first.
 *
 * @param {object[]} rows - joinPlays rows
 * @param {number} [top=8] - cap per side
 * @returns {{over: object[], under: object[]}} q>2 and q<0.5 rows sorted by extremity
 */
function extremesOf(rows, top = 8) {
    return {
        over: rows.filter((r) => qOf(r) > 2).sort((a, b) => qOf(b) - qOf(a)).slice(0, top),
        under: rows.filter((r) => qOf(r) < 0.5).sort((a, b) => qOf(a) - qOf(b)).slice(0, top),
    };
}

/**
 * Run the synthetic unit check that pins the join semantics.
 */
/**
 * Decide whether one rid's events form a REAL completed run: both its runstart and runend
 * must be in-window. Reconnect artifacts log sessionstart->runend with no runstart for that rid.
 *
 * @param {object[]} evs - events of one rid sorted by ts
 * @returns {object|null} {ante,won} when real, null for artifacts
 */
function classifyRealRun(evs) {
    const end = evs.find((e) => e.e === 'runend');
    const started = evs.some((e) => e.e === 'runstart');

    return end && started ? { ante: end.ante, won: end.won } : null;
}

/**
 * Run the synthetic unit checks pinning join, real-run classification, and extremes.
 */
function selftest() {
    const evs = [
        { e: 'decide', a: 'play', pred: 99, rchips: 500, fam: 'Ghost' },
        { e: 'turn', chips: 100 },
        { e: 'decide', a: 'play', pred: 50, rchips: 160, fam: 'Pair' },
        { e: 'decide', a: 'discard', pred: null, rchips: 0, fam: null },
        { e: 'turn', chips: 160 },
        { e: 'decide', a: 'play', pred: 30, rchips: 160, fam: 'Zero' },
    ];
    const got = joinPlays(evs);

    if (got.length !== 1 || got[0].fam !== 'Pair' || got[0].act !== 60) {
        throw new Error(`joinPlays broken: ${JSON.stringify(got)}`);
    }

    if (classifyRealRun([{ e: 'sessionstart' }, { e: 'runend', ante: 2, won: false }]) !== null) {
        throw new Error('reconnect artifact must not count as a real run');
    }

    const real = classifyRealRun([{ e: 'runstart' }, { e: 'runend', ante: 1, won: false }]);

    if (!real || real.ante !== 1 || real.won !== false) {
        throw new Error('fast real death (no decide threshold) must count as real run');
    }

    const ext = extremesOf([{ fam: 'Pair', pred: 743, act: 60 }, { fam: 'High Card', pred: 16, act: 377 }, { fam: 'Pair', pred: 100, act: 90 }]);

    if (ext.over.length !== 1 || ext.over[0].fam !== 'Pair' || ext.under.length !== 1 || ext.under[0].fam !== 'High Card') {
        throw new Error(`extremesOf broken: ${JSON.stringify(ext)}`);
    }

    console.log('ANALYZE SELFTEST OK');
}

/**
 * Aggregate and print accuracy, depth, and joker-values reports.
 *
 * @param {string} logPath - path to out/log.jsonl
 * @param {number} since - only consider events with ts strictly after this epoch-ms
 */
function report(logPath, since) {
    const byRid = new Map();
    const valProbe = new Map();
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');

    for (const ln of lines) {
        if (!ln.trim()) {
            continue;
        }

        let j;

        try {
            j = JSON.parse(ln);
        } catch {
            continue;
        }

        if (typeof j.ts !== 'number' || j.ts <= since) {
            continue;
        }

        if (j.rid !== undefined && (j.e === 'turn' || j.e === 'decide' || j.e === 'runend' || j.e === 'runstart')) {
            if (!byRid.has(j.rid)) {
                byRid.set(j.rid, []);
            }

            byRid.get(j.rid).push(j);
        }

        if (j.e === 'turn' && Array.isArray(j.jk)) {
            for (const [name, , , vals] of j.jk) {
                const key = `${name} ${JSON.stringify(vals)}`;

                valProbe.set(key, (valProbe.get(key) || 0) + 1);
            }
        }
    }

    const rows = [];
    const runs = [];

    for (const [rid, evs] of byRid) {
        evs.sort((a, b) => a.ts - b.ts);
        const plays = joinPlays(evs);

        rows.push(...plays);
        const cls = classifyRealRun(evs);

        if (cls) {
            const last = evs.filter((e) => e.e === 'decide' && e.a === 'play').slice(-2);

            runs.push({
                rid, nd: evs.filter((e) => e.e === 'decide').length, ante: cls.ante, won: cls.won, last: last.map((l) => `${l.b}/${l.fam} pred ${l.pred} rem ${l.rem}/${l.tgt}`),
            });
        }
    }

    let sum = 0;
    let lo = 0;
    let ok = 0;
    let mid = 0;
    let hi = 0;

    for (const r of rows) {
        const q = r.pred / r.act;

        sum += q;

        if (q < 0.5) {
            lo += 1;
        } else if (q <= 2) {
            ok += 1;
        } else if (q <= 4) {
            mid += 1;
        } else {
            hi += 1;
        }
    }

    console.log(`n=${rows.length} mean=${rows.length ? (sum / rows.length).toFixed(3) : '-'} | under<0.5:${lo} ok0.5-2:${ok} 2-4x:${mid} over>4:${hi}`);

    const ext = extremesOf(rows);

    console.log('worst OVER (pred/act>2):');

    for (const r of ext.over) {
        console.log(fmtRow(r));
    }

    console.log('worst UNDER (pred/act<0.5):');

    for (const r of ext.under) {
        console.log(fmtRow(r));
    }

    console.log(`real runs (runstart+runend in window): ${runs.length} won=${runs.filter((r) => r.won).length} depth ${runs.map((r) => r.ante).sort((a, b) => a - b).join(',')}`);

    for (const r of runs.slice(-8)) {
        console.log(`  rid ${r.rid} ante ${r.ante} won=${r.won} :: ${r.last.join(' | ')}`);
    }

    console.log('top joker value shapes:');

    for (const [k, c] of [...valProbe.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
        console.log(`  ${c}x ${k}`);
    }
}

if (process.argv.includes('--selftest')) {
    selftest();
} else {
    const sIdx = process.argv.indexOf('--since');
    const lIdx = process.argv.indexOf('--log');

    report(lIdx !== -1 ? process.argv[lIdx + 1] : 'out/log.jsonl', sIdx !== -1 ? Number(process.argv[sIdx + 1]) : 0);
}
