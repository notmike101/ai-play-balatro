/* route.mjs — era census for the shadow clear-P solver (lib/routes.mjs): how often
   would the multi-hand lookahead have overruled the single-hand decision, and in
   which direction. Switch when disagreements cluster where the loser is the chosen
   action AND deep runs (a4+) dominate the sample. */
import fs from 'node:fs';
import readline from 'node:readline';

const since = Number(process.argv[2] ?? 0);
const rl = readline.createInterface({ input: fs.createReadStream('out/log.jsonl'), crlfDelay: Infinity });

const t = {};

for await (const line of rl) {
    if (!line.includes('"e":"route"')) {
        continue;
    }

    let j;

    try {
        j = JSON.parse(line);
    } catch {
        continue;
    }

    if ((j.ts ?? 0) < since || !j.ante) {
        continue;
    }

    const band = j.ante >= 4 ? 'a4+' : 'a2-3';
    (t[band] ??= { n: 0, contra: 0, miss: 0, sum: 0 });
    t[band].n++;
    const other = j.a === 'play' ? j.pDisc : j.pNow;

    if (j.a === 'play' ? j.pDisc > j.pNow + 0.05 : j.pNow > j.pDisc + 0.05) {
        t[band].contra++;
        t[band].sum += Math.abs(other - (j.a === 'play' ? j.pNow : j.pDisc));
    }

    if (Math.abs(j.pNow - j.pDisc) <= 0.05) {
        t[band].miss++;
    }
}

console.log('band      n     contra%  avg-ΔP-when-contra  tie%');
for (const [k, v] of Object.entries(t)) {
    console.log(k.padEnd(9), String(v.n).padEnd(6), (100 * v.contra / v.n).toFixed(1).padStart(6), v.contra ? (v.sum / v.contra).toFixed(2).padStart(20) : '-', (100 * v.miss / v.n).toFixed(0).padStart(8));
}
