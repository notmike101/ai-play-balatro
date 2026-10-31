/* eslint-disable @stylistic/max-statements-per-line -- compact analysis one-liners, promoted from tmp/ as-is */
/* Interest census v2: payout = money AFTER cash_out minus money BEFORE (same rid).
   money_before = last row with money field at ts < cashout (shopdone/blind/hand),
   money_after  = first row with money field at ts > cashout (shopdump/...).
   Fit: payout - base(ante,type) vs floor(money_before/5). */
import { readFileSync } from 'node:fs';

const L = readFileSync(new URL('../out/log.jsonl', import.meta.url), 'utf8').trim().split('\n');

const rows = [];

for (const s of L) {
    try {
        const j = JSON.parse(s);

        if (j && j.ts) {
            rows.push(j);
        }
    } catch { /* skip */ }
}

rows.sort((a, b) => a.ts - b.ts);

const seq = {};

for (const j of rows) {
    if (j.e === 'blind' && j.name) {
        const sel = String(j.name).split(',').find((x) => x.endsWith(':Select'));

        (seq[j.rid] ??= []).push({ ts: j.ts, ante: j.ante, b: sel ? sel.split(':')[0] : '?' });
    }
}

const moneyRows = rows.filter((j) => typeof j.money === 'number');
const out = [];

for (const j of rows) {
    if (j.e !== 'cashout') {
        continue;
    }

    const btn = /Cash Out:\s+\$(\d+)/.exec((j.ctrls || []).join('|'));
    const before = moneyRows.filter((m) => m.rid === j.rid && m.ts < j.ts && m.e !== 'cashout').pop();
    const after = moneyRows.find((m) => m.rid === j.rid && m.ts > j.ts && m.e !== 'cashout');
    const s = (seq[j.rid] || []).filter((b) => b.ante === j.ante && b.ts < j.ts).pop();

    out.push({
        ante: j.ante,
        b: j.blind || (s ? s.b : '?'),
        btn: btn ? +btn[1] : null,
        before: before ? before.money : null,
        after: after ? after.money : null,
    });
}

console.log('ante blind  btn  before->after  (gain)  floor(b/5)');

for (const p of out.sort((x, y) => x.ante - y.ante || (x.b < y.b ? -1 : 1))) {
    const gain = p.after !== null && p.before !== null ? p.after - p.before : null;

    console.log(`a${p.ante} ${String(p.b).padEnd(11)} btn=${p.btn} ${p.before}->${p.after} gain=${gain} ${p.before !== null ? `f${Math.floor(p.before / 5)}` : ''}`);
}

/* regression rows where gain known and blind known: group by blind name, sort before */
const g = {};

for (const p of out) {
    if (p.before !== null && p.after !== null && p.b !== '?') {
        (g[p.b] ??= []).push(p);
    }
}

console.log('\n-- gain vs carried (per blind type, ante-sorted) --');
for (const [k, v] of Object.entries(g)) {
    console.log(k, v.sort((x, y) => x.ante - y.ante || x.before - y.before).map((p) => `a${p.ante} ${p.before}+${p.after - p.before}`).join(' | '));
}
