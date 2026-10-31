/* tools/watchrun.mjs — one-shot wake loop: exit when >=1 NEW CLEAN rundigest lands with
   t > argv[2] (mid-run driver kills create sessionstart-split fragment rids whose digests
   under-count actions — those never fire the wake, they go to watchrun.log as fragment-skip).
   Prints NEW_RUNS n + digest lines + up to 14 ladder rows, then exits 0. 55min hard exit 1.
   Incremental: startup scans the event log once; ticks read only appended bytes. */
import { readFileSync, appendFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';

const P = new URL('../out/digests.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const L = new URL('../out/log.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/* lifecycle state built at startup, extended per tick from appended bytes only */
const life = new Map(); /* rid -> { s: runstart ts|null, e: runend ts|null } */
const sessions = []; /* every sessionstart ts (parity with original: not rid-filtered) */

/**
 * Fold one parsed lifecycle event into the rid state map.
 *
 * @param {object} j - parsed event row (runstart/runend/sessionstart)
 * @returns {void}
 */
function fold(j) {
    if (j.e === 'sessionstart') {
        sessions.push(j.ts);
        return;
    }
    const st = life.get(j.rid) ?? { s: null, e: null };
    if (j.e === 'runstart') st.s = j.ts;
    if (j.e === 'runend') st.e = j.ts;
    life.set(j.rid, st);
}

/**
 * Whether a rundigest denotes a fully observed run: runstart AND runend for its rid
 * with no sessionstart strictly between them (a mid-run driver kill splits runStats/EMA
 * even when rid is restored from state.json) and the source-side complete flag, when
 * present, not false.
 *
 * @param {object} d - parsed rundigest object
 * @returns {boolean} true when usable as window evidence
 */
function isClean(d) {
    if (d.complete === false) {
        return false;
    }
    const st = life.get(d.rid);
    if (!st || st.s === null || st.e === null) {
        return false;
    }
    return !sessions.some((ts) => ts > st.s && ts < st.e);
}

/**
 * Print ladder-evidence rows (sell/swap, Death clone, Steel/Glass enhance, seals,
 * Magic Trick, tarot uses) for the woken runs so one wake answers armed watches.
 * Full-log scan runs only at fire time (process exits right after).
 *
 * @param {number[]} rids - run ids to scan in the event log
 * @returns {void} prints matches, capped
 */
function ladder(rids) {
    const RE = /"e":"(shopdone|use|exec|packdump)"|"boss"/;
    const KEY = /(sell|Death|Steel|Glass|Magic|seal|S:|tc:|enhance|trim|stone|Emperor|Judgement)/;
    let n = 0;
    for (const l of readFileSync(L, 'utf8').trim().split('\n')) {
        const m = /"rid":(\d+)/.exec(l);
        if (!m || !rids.includes(Number(m[1])) || !RE.test(l) || !KEY.test(l)) {
            continue;
        }
        console.log('LADDER', l.slice(0, 300));
        if (++n >= 14) {
            break;
        }
    }
}

/**
 * Read appended bytes from a file offset, invoking a per-line callback; returns the new
 * byte offset at a line boundary. Rotate/truncate (size < off) restarts from 0.
 *
 * @param {string} file - path
 * @param {number} off - last committed byte offset
 * @param {(line: string) => void} onLine - per complete line
 * @returns {number} new offset
 */
function tailLines(file, off, onLine) {
    let size;
    try {
        size = statSync(file).size;
    } catch {
        return off;
    }
    if (size < off) {
        off = 0;
    }
    if (size === off) {
        return off;
    }
    const fd = openSync(file, 'r');
    try {
        const buf = Buffer.alloc(size - off);
        readSync(fd, buf, 0, buf.length, off);
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl === -1) return off;
        const text = buf.subarray(0, lastNl).toString('utf8');
        for (const s of text.split('\n')) {
            if (!s.trim()) continue;
            onLine(s);
        }
        return off + lastNl + 1;
    } finally {
        closeSync(fd);
    }
}

const t0 = process.argv[2] ? Number(process.argv[2]) : Date.now() - 1;

/* startup: one pass over lifecycle rows; digest baseline = current line count */
let lOff = tailLines(L, 0, (s) => {
    if (!s.includes('"runstart"') && !s.includes('"runend"') && !s.includes('"sessionstart"')) {
        return;
    }
    try {
        fold(JSON.parse(s));
    } catch { /* skip */ }
});
let dOff = existsSync(P) ? statSync(P).size : 0;
const hard = Date.now() + 3_300_000;

for (;;) {
    lOff = tailLines(L, lOff, (s) => {
        if (!s.includes('"runstart"') && !s.includes('"runend"') && !s.includes('"sessionstart"')) {
            return;
        }
        try {
            fold(JSON.parse(s));
        } catch { /* skip */ }
    });
    const fresh = [];
    dOff = tailLines(P, dOff, (s) => {
        try {
            const d = JSON.parse(s);
            if (d.t > t0) fresh.push(d);
        } catch { /* skip */ }
    });
    if (fresh.length) {
        const clean = fresh.filter(isClean);
        const dirty = fresh.length - clean.length;
        if (dirty) {
            appendFileSync(P.replace('digests.jsonl', 'watchrun.log'), `fragment-skip ${new Date().toISOString()} n=${dirty}\n`);
        }
        if (clean.length) {
            console.log(`NEW_RUNS ${clean.length}${dirty ? ` (+${dirty} FRAGMENT digests skipped)` : ''}`);
            console.log(clean.map((d) => JSON.stringify(d)).join('\n'));
            try {
                ladder(clean.map((d) => d.rid));
            } catch { /* ladder scan never blocks the wake */ }
            appendFileSync(P.replace('digests.jsonl', 'watchrun.log'), `fired ${new Date().toISOString()} n=${clean.length}\n`);
            process.exit(0);
        }
    }
    if (Date.now() > hard) {
        console.log('TIMEOUT 55min no new digest');
        process.exit(1);
    }
    await new Promise((r) => {
        setTimeout(r, 10_000);
    });
}
