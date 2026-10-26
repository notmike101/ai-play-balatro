// shot.mjs [outfile] — screenshot the poker.gl.ax page via CDP
import WebSocket from 'ws';
import fs from 'node:fs';

const list = await (await fetch('http://127.0.0.1:62519/json/list')).json();
const t = list.find((x) => x.url.startsWith('https://poker.gl.ax'));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();

/**
 * Send a CDP method with params over the page websocket and await its reply.
 *
 * @param {string} m - CDP method name
 * @param {object} [p] - method parameters
 * @returns {Promise<unknown>} resolves with the CDP result for this call
 */
const send = (m, p = {}) => new Promise((res, rej) => {
    const i = ++id;

    pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
});

ws.on('message', (m) => {
    const j = JSON.parse(m);

    if (j.id && pend.has(j.id)) {
        const p = pend.get(j.id);

        pend.delete(j.id);
        j.error ? p.rej(new Error(JSON.stringify(j.error))) : p.res(j.result);
    }
});
await new Promise((r) => {
    ws.on('open', r);
});
const s = await send('Page.captureScreenshot', { format: 'png' });

fs.writeFileSync(process.argv[2] || 'shot.png', Buffer.from(s.data, 'base64'));
console.log('shot', `${Math.trunc(s.data.length / 1_024)}KB`);
process.exit(0);
