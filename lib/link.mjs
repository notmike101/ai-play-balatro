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
 * Open one CDP websocket to the game tab. Fire-and-forget style; never throws.
 *
 * @returns {Promise<import('ws').WebSocket | null>} connected socket or null
 */
async function cdpPageWs() {
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => {
            ctl.abort();
        }, 5_000);
        const list = await (await fetch('http://127.0.0.1:9222/json', { signal: ctl.signal })).json();

        clearTimeout(t);
        const page = list.find((x) => x.type === 'page' && String(x.url).includes('poker.gl.ax'));

        if (!page?.webSocketDebuggerUrl) {
            return null;
        }

        const { default: WebSocket } = await import('ws');
        const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });

        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
            setTimeout(() => {
                reject(new Error('cdp ws timeout'));
            }, 5_000);
        });

        return ws;
    } catch {
        return null;
    }
}

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

    /* AUTONOMOUS PAGE REVIVE (16:41-18:19 outage ate ~100min of run throughput in a
       driver-crash loop waiting on a human): reload the game tab over CDP - the page
       reconnects to 4180 by itself and auto-resumes the saved run (observed 18:20);
       same recovery as the manual runbook reload step, just unsupervised */
    if (await reloadPage()) {
        say('page reloaded over CDP, re-observing');
        /* BOOT BUDGET (proved 10-30 01:0xZ, 7 reload-FATAL cycles): the page
           only connects to 4180 AT LOAD and WebGPU boot takes 1-2 min, so a
           local_timeout right after a reload is EXPECTED. Failing fast here
           kills the driver, and its restart turns the host over - which the
           now-connected-but-later page can never reach (orphan loop). Wait it
           out on the SAME host instead. */
        const until = Date.now() + 480_000;

        while (Date.now() < until) {
            await sleep(15_000);

            const r = await request({ op: 'observe' }, 30_000);

            if (r.ok) {
                return r.result;
            }

            if (!['local_timeout', 'no_browser'].includes(r.error?.code)) {
                break;
            }

            say('page rebooting, budget left', `${Math.round((until - Date.now()) / 1_000)}s`);
        }
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

/**
 * Wake a ZOMBIE-PAUSED game (a8 Bell win rescue 10-29): after a user resume/alt-tab the
 * game can sit in hand phase reporting overlay:null, ready:true yet reject EVERY action
 * with action_unavailable; WS reconnect, act retries and Page.reload do NOT clear it —
 * only a real Escape keystroke (system input) woke it; CDP-dispatched key events are
 * the closest the driver can send unattended. bringToFront first (focus is what the
 * game's focus-pause watches). If the Escape opens the pause overlay, the driver's
 * overlay back-out handler returns to the table on the next loop iteration.
 *
 * @returns {Promise<boolean>} true when the key events were sent
 */
export async function nudgeUnpause() {
    try {
        const ws = await cdpPageWs();

        if (!ws) {
            return false;
        }

        /* CDP Input domain has no sendSync over plain ws; two frames + no text
           (Escape produces none) is what wakes the focus-paused game */
        /**
         * One Escape key event frame for Input.dispatchKeyEvent.
         *
         * @param {string} type - CDP key event type, rawKeyDown or keyUp
         * @returns {string} JSON CDP message
         */
        function ev(type) {
            return JSON.stringify({ id: 2, method: 'Input.dispatchKeyEvent', params: { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKey: 27 } });
        }

        ws.send(JSON.stringify({ id: 1, method: 'Page.bringToFront' }));
        ws.send(ev('rawKeyDown'));
        ws.send(ev('keyUp'));
        await new Promise((r) => {
            setTimeout(r, 1_500);
        });
        ws.close();

        return true;
    } catch {
        return false;
    }
}

/**
 * Reload the game tab through Chrome DevTools Protocol (loopback 9222).
 * Fire-and-forget with a hard time budget; never throws.
 *
 * @returns {Promise<boolean>} true when the reload command was accepted
 */
export async function reloadPage() {
    try {
        const ws = await cdpPageWs();

        if (!ws) {
            return false;
        }

        ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: false } }));
        await new Promise((resolve) => {
            setTimeout(resolve, 1_500);
        });
        ws.close();

        return true;
    } catch {
        return false;
    }
}

/**
 * Trusted CDP mouse click at CSS viewport px (menu PLAY self-service; the
 * authored WS setup_run click crashes the game, a dispatched trusted click
 * opens the run overlay - validated 2026-10-30 with tmp/click.mjs).
 * Fire-and-forget with a hard time budget; never throws.
 *
 * @param {number} x - CSS viewport px
 * @param {number} y - CSS viewport px
 * @returns {Promise<boolean>} true when the event sequence was sent
 */
export async function clickPage(x, y) {
    try {
        const ws = await cdpPageWs();

        if (!ws) {
            return false;
        }

        /* Spec pairing is MANDATORY: release must carry clickCount:1 (the old
           clickCount:0 release never synthesized a click - the game saw hover
           only, which is where the 'physical Play click required' myth came
           from; validated 2026-10-30 with tmp/click2.mjs on live menus) */
        ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } }));
        await new Promise((resolve) => {
            setTimeout(resolve, 200);
        });
        ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 } }));
        await new Promise((resolve) => {
            setTimeout(resolve, 200);
        });
        ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 } }));
        await new Promise((resolve) => {
            setTimeout(resolve, 400);
        });

        ws.close();

        return true;
    } catch {
        return false;
    }
}
