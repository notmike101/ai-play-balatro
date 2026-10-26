/* cdp.mjs — minimal CDP browser-ws helper: open/activate/navigate the poker.gl.ax tab.
   usage: node cdp.mjs <open|activate|reload|list> [url] */
import WebSocket from 'ws';

const PORT = process.env.CDP_PORT || '62519';
const URL_GAME = process.argv[3] || 'https://poker.gl.ax/';

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl, { maxPayload: 64 * 1_024 * 1_024 });
let id = 0;
const pending = new Map();

/**
 * Send a raw CDP message object over the browser websocket and await its reply.
 *
 * @param {object} msg - CDP payload with method and params, plus optional sessionId
 * @returns {Promise<unknown>} resolves with the CDP result matching the generated message id
 */
const sendRaw = (msg) => new Promise((res, rej) => {
    const mid = ++id;

    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, ...msg }));
});

/**
 * Send a CDP method with params over the browser websocket.
 *
 * @param {string} method - CDP method name
 * @param {object} [params] - method parameters
 * @returns {Promise<unknown>} resolves with the CDP result for this call
 */
const send = (method, params = {}) => sendRaw({ method, params });

ws.on('message', (m) => {
    const j = JSON.parse(m);

    if (j.id && pending.has(j.id)) {
        const p = pending.get(j.id);

        pending.delete(j.id);
        j.error ? p.rej(new Error(JSON.stringify(j.error))) : p.res(j.result);
    }
});
await new Promise((r) => {
    ws.on('open', r);
});

const cmd = process.argv[2] || 'list';
const targets = await send('Target.getTargets');
const pages = targets.targetInfos.filter((t) => t.type === 'page');

switch (cmd) {
    case 'list': {
        console.log(JSON.stringify(pages, null, 1));
        break;
    }
    case 'open': {
        let t = pages.find((p) => p.url.startsWith(URL_GAME));

        if (!t) {
            const { targetId } = await send('Target.createTarget', { url: URL_GAME });

            t = { targetId };
        }

        await send('Target.activateTarget', { targetId: t.targetId });
        console.log('OK', t.targetId);

        break;
    }
    case 'activate': {
        const t = pages.find((p) => p.url.startsWith(URL_GAME));

        if (!t) {
            throw new Error('no game tab');
        }

        await send('Target.activateTarget', { targetId: t.targetId });
        console.log('OK', t.targetId);

        break;
    }
    case 'reload': {
        const t = pages.find((p) => p.url.startsWith(URL_GAME));

        if (!t) {
            throw new Error('no game tab');
        }

        const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });

        await sendRaw({ method: 'Page.enable', params: {}, sessionId });
        await sendRaw({ method: 'Page.navigate', params: { url: URL_GAME }, sessionId });
        console.log('OK reloaded', t.targetId);

        break;
    }
// No default
}

ws.close();
process.exit(0);
