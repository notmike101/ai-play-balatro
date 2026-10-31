/* tools/cohort.mjs — ONE-SHOT policy-epoch readout from out/runs.db (run tools/dbimport.mjs first).
   Prints every deploy epoch (from the deploy table) with its cohort's run stats side by side,
   so cohort comparisons no longer need manual t-threshold bookkeeping. Optional arg: number of
   epochs to show (default 6). Per-epoch: n / avgA / wins / final-depth hist / a1-a2 share /
   focal-L1@death(a>2) / board-full / celestial share / near-miss(<1500) share / flip rows. */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DIR = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const db = new DatabaseSync(path.join(DIR, 'out', 'runs.db'), { readOnly: true });

/* VERDICT MODE: tools/cohort.mjs --verdict <headSha> [--base <baseSha>]
   Prints the standing pre-registered table for the window starting at <headSha>'s deploy
   (or its ts if it is not in the deploy table) vs the window that started at <baseSha>
   (default: the deploy before head). Replaces the per-wake one-liner censuses. */
const argv = process.argv.slice(2);

if (argv[0] === '--verdict') {
    const dep = db.prepare('SELECT sha, ts FROM deploy ORDER BY ts').all();
    /**
     *
     * @param s
     */
    const find = (s) => dep.find((d) => d.sha === s || d.sha.startsWith(s));
    const head = find(argv[1]);

    if (!head) {
        console.error('head sha not in deploy table');
        process.exit(1);
    }

    /* window end: the next --until ts if given, else NOW. loopdrv restarts stamp deploy
       rows at the then-current working-tree sha (zero-delta refactors included), so a
       later deploy ts is NOT proof of a policy change - pass --until at the real
       policy-deploy boundary instead. */
    const hi = argv.includes('--until') ? Number(argv[argv.indexOf('--until') + 1]) : undefined;
    /**
     *
     * @param d
     * @param e
     */
    const same = (d, e) => d.sha.slice(0, 7) === e.sha.slice(0, 7);
    let base = argv.includes('--base')
        ? find(argv[argv.indexOf('--base') + 1])
        : dep.slice(0, dep.indexOf(head)).reverse().find((d) => !same(d, head));

    if (base) {
        const nb = dep.find((d) => d.ts > base.ts && !same(d, base) && d.ts < head.ts);

        base = { sha: base.sha, lo: base.ts, hi: nb ? Math.min(nb.ts, head.ts) : head.ts };
    }

    const rows = db.prepare(`SELECT ante a,lvlMap lm,lvlAct la,celestial c,jokers j,gap g,focal f,focalLvl fl FROM rundigest WHERE t>=? AND complete=1${hi ? ' AND t<?' : ''}`).all(head.ts, ...(hi ? [hi] : []));

    /**
     *
     * @param rs
     */
    function stat(rs) {
        const n = rs.length;

        if (!n) {
            return 'n=0';
        }

        const sup = rs.filter((r) => r.la > 0);
        /**
         *
         * @param k
         * @param m
         */
        const pct = (k, m) => `${(m ? (100 * k / m) : Number.NaN).toFixed(0)}%`;

        return `n=${n} avgA=${(rs.reduce((s, r) => s + r.a, 0) / n).toFixed(2)}`
            + ` a12=${pct(rs.filter((r) => r.a <= 2).length, n)}(${pct(sup.filter((r) => r.a <= 2).length, sup.length)} supplied)`
            + ` spread=${pct(rs.filter((r) => ((r.lm || '').match(/:/g) || []).length >= 3).length, n)}`
            + ` j5=${pct(rs.filter((r) => r.j >= 5).length, n)} a5+=${pct(rs.filter((r) => r.a >= 5).length, n)}`
            + ` starved=${pct(rs.filter((r) => !r.c && !r.la).length, n)}`
            + ` near=[${rs.filter((r) => r.g < 1_000).map((r) => r.g).sort((x, y) => x - y).slice(0, 10).join(',')}]`;
    }

    console.log(`HEAD ${head.sha.slice(0, 7)}: ${stat(rows)}`);

    if (base) {
        const brows = db.prepare('SELECT ante a,lvlMap lm,lvlAct la,celestial c,jokers j,gap g FROM rundigest WHERE t>=? AND t<? AND complete=1').all(base.lo, base.hi);

        console.log(`BASE ${base.sha.slice(0, 7)}: ${stat(brows)}`);
    }

    process.exit(0);
}

const N = Number(argv[0] ?? 6);

const dep = db.prepare('SELECT sha, ts FROM deploy ORDER BY ts DESC LIMIT ?').all(N).reverse();

console.log('epochs (commit time; runs counted = digest t in [epoch, next epoch)):');

for (let i = 0; i < dep.length; i++) {
    const lo = dep[i].ts;
    const hi = i + 1 < dep.length ? dep[i + 1].ts : 9e15;
    const rs = db.prepare('SELECT rid, m, w FROM runmax WHERE t0>=? AND t0<?').all(lo, hi);
    const n = rs.length;
    const avgA = n ? (rs.reduce((a, r) => a + r.m, 0) / n).toFixed(2) : '-';
    const wins = rs.reduce((a, r) => a + r.w, 0);
    const hist = {};

    for (const r of rs) {
        hist[r.m] = (hist[r.m] || 0) + 1;
    }

    const dd = db.prepare('SELECT focalLvl fl, ante a, jokers j, celestial c, gap g, t FROM rundigest WHERE t>=? AND t<?').all(lo, hi);
    const a2p = dd.filter((r) => r.a > 2);
    const l1 = a2p.filter((r) => r.fl === 1).length;
    const full = dd.filter((r) => r.j >= 5).length;
    const cel = dd.filter((r) => r.c === 1).length;
    const near = dd.filter((r) => r.g !== null && r.g < 1_500).length;
    const gated = db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND body LIKE \'%"gated":1%\' AND ts>=? AND ts<?').get(lo, hi).c;
    const fm = db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND body LIKE \'%"shelfHasWant":1%\' AND ts>=? AND ts<?').get(lo, hi).c;

    console.log(
        `${dep[i].sha.slice(0, 7)} n=${String(n).padStart(3)} avgA=${String(avgA).padStart(4)} w=${wins}`
        + ` hist=${JSON.stringify(hist)}`
        + ` L1@death(a>2)=${l1}/${a2p.length} full5=${n ? Math.round(100 * full / dd.length) : 0}% cel=${n ? Math.round(100 * cel / dd.length) : 0}%`
        + ` near<1.5k=${near}/${dd.length} flips=${db.prepare('SELECT COUNT(*) c FROM other WHERE e=\'shopflip\' AND ts>=? AND ts<?').get(lo, hi).c}(want=${fm} gated=${gated})${i === dep.length - 1 ? '   <-- CURRENT' : ''}`,
    );
}
