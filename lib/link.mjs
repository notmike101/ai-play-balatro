// link.mjs — stdio JSON-lines link to automation-host.mjs (spawns the host child on import).
import { spawn } from 'node:child_process';
import { DIR, say, sleep } from './knowledge.mjs';

const HOST_ARGS = ['automation-host.mjs', '--origin', 'https://poker.gl.ax', '--stay-open'];
const host = spawn(process.execPath, HOST_ARGS, { cwd: DIR });
let buf = '';
const pending = new Map();

host.stdout.on('data', (d) => {
    buf += d;
    let i;

    while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();

        buf = buf.slice(i + 1);

        if (!line.startsWith('{')) {
            continue;
        }

        let j;

        try {
            j = JSON.parse(line);
        } catch {
            continue;
        }

        if (j.event) {
            say('evt', j.event, j.session ?? '');
            continue;
        }

        const p = pending.get(j.id);

        if (p) {
            pending.delete(j.id);
            p(j);
        }
    }
});
host.stderr.on('data', (d) => say('stderr', d.toString().trim().slice(0, 200)));
host.on('exit', (c) => {
    say('host exited', c);
    process.exit(1);
});
/**
 * Kill the host child process so it cannot orphan when the driver exits.
 */
const reap = () => {
    try {
        host.kill('SIGKILL');
    } catch {
        // host already gone: nothing left to reap
    }
};

// never orphan the --stay-open host: it holds port 4180 + stale request-id receipts that poison the next driver with request_conflict
process.on('exit', reap);
process.on('SIGINT', () => process.exit(2));
process.on('SIGTERM', () => process.exit(15));
process.on('uncaughtException', (e) => {
    say('FATAL', e.message);
    process.exit(1);
});
let rid = 0;
/* ids must be unique across driver RESTARTS: the page-side adapter keeps its receipt/dedup table across WS reconnects,
   so reused ids replay stale cached responses and the first differing payload trips request_conflict forever. */
const nonce = Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

/**
 * Send a JSON-lines request to the host and await its response.
 *
 * @param {object} obj - request payload (op plus op-specific fields)
 * @param {number} [timeout] - milliseconds to wait before synthesizing a local_timeout response
 * @returns {Promise<object>} host response envelope, or the local timeout envelope
 */
export function request(obj, timeout = 60_000) {
    const id = `${nonce}-${++rid}`;
    const line = JSON.stringify({ v: 1, id, ...obj });

    return new Promise((res) => {
        const t = setTimeout(() => {
            pending.delete(id);
            res({ id, ok: false, error: { code: 'local_timeout', message: 'no response' } });
        }, timeout);

        pending.set(id, (j) => {
            clearTimeout(t);
            res(j);
        });
        host.stdin.write(`${line}\n`);
    });
}

/**
 * Observe the game state, retrying on failure; throws when retries are exhausted.
 *
 * @param {number} [retries] - extra attempts after the first one
 * @returns {Promise<object>} current observation result
 */
export async function observe(retries = 2) {
    for (let a = 0; a <= retries; a++) {
        const r = await request({ op: 'observe' });

        if (r.ok) {
            return r.result;
        }

        say('observe failed', r.error?.code, 'retry');
        await sleep(4_000);
    }

    throw new Error('observe failed repeatedly');
}

/**
 * Send one action request to the host and return its response.
 *
 * @param {object} args - action arguments (epoch plus action-specific fields)
 * @returns {Promise<object>} response envelope with ok plus optional result
 */
export async function act(args) {
    // returns {ok, result?} — stale_observation handled by caller loop via observe(); act once per plan.
    const r = await request({ op: 'act', args }, 90_000);

    return r;
}
