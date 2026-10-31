// throwaway: report CDP viewport metrics + click at given CSS coords option
import WebSocket from 'ws';

const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('poker.gl.ax'));
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0;
const pending = new Map();

ws.on('message', (b) => {
    const m = JSON.parse(b.toString());

    if (pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
    }
});

/**
 * Send a CDP request and await its matching response.
 *
 * @param {string} method - CDP method name
 * @param {object} params - method params
 * @returns {Promise<object>} response
 */
function send(method, params = {}) {
    return new Promise((resolve) => {
        const mid = ++id;

        pending.set(mid, resolve);
        ws.send(JSON.stringify({ id: mid, method, params }));
    });
}

await new Promise((resolve) => {
    ws.once('open', resolve);
});
await send('Page.enable');
const lm = await send('Page.getLayoutMetrics');

console.log('css', JSON.stringify(lm.result.cssVisualViewport ?? lm.result.visualViewport).slice(0, 200));
const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio})' });

console.log('win', ev.result.result.value);
ws.close();
