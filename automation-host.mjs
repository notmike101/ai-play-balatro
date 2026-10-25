#!/usr/bin/env node
// Optional reference host. The game remains a static application and initiates
// the WebSocket connection; this process owns only the loopback controller.
import { isUtf8 } from 'node:buffer';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = 4180;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PENDING = 8;
const MAX_RECEIPTS = 256;
const RESPONSE_TIMEOUT_MS = 60_000;
const HOSTED_ORIGIN = 'https://poker.gl.ax';
const DEFAULT_ORIGINS = ['http://127.0.0.1:4173', 'http://localhost:4173', HOSTED_ORIGIN];
const OPS = new Set(['observe', 'act', 'describe']);
const ERRORS = Object.freeze({
  invalid_request: 'Invalid automation request.',
  request_conflict: 'Request ID was already used for a different request.',
  busy: 'Automation request queue is full.',
  operation_failed: 'Automation operation failed.',
  response_too_large: 'Automation response exceeds the message limit.',
  cancelled: 'Automation request was cancelled before dispatch.',
  invalid_action: 'Invalid gameplay action.',
  game_unavailable: 'The game is not available for automation.',
  stale_observation: 'The observation is no longer current.',
  action_unavailable: 'The gameplay action is not currently available.',
  unsettled: 'The game did not reach a settled decision.',
  no_browser: 'No browser connected before the request timeout.',
  response_timeout: 'Browser response timed out; the action outcome is unknown.',
  session_changed: 'The browser session changed; the prior action outcome is unknown.',
  host_stopped: 'The automation host stopped; the action outcome is unknown.',
});

function help() {
  return `Usage: ./scripts/automation-host.sh [--origin ORIGIN] [--stay-open]

Listen only on ws://127.0.0.1:${PORT}/ for the game's automatic connection.
The normal game origins are ${DEFAULT_ORIGINS.join(' and ')}.
--origin replaces them with https://poker.gl.ax or one exact http:// loopback
origin for an isolated eval profile/site. The socket always stays on localhost.
--stay-open keeps listening after stdin closes; otherwise EOF waits up to 60 s
for each outstanding request and exits once all replies have been delivered.

Read newline-delimited JSON requests from stdin, one request per line:
  {"v":1,"id":"obs-1","op":"observe"}
  {"v":1,"id":"help-1","op":"describe"}
  {"v":1,"id":"move-1","op":"act","args":{...}}
Use describe/observe to discover semantic actions; raw input/eval is unavailable.
IDs are 1..128 ASCII token characters [A-Za-z0-9._:-] or nonnegative safe integers.
Requests and responses are bounded to 64 KiB, with at most 8 outstanding requests.

Stdout contains only JSON: listening/connected/disconnected lifecycle events and
the browser's response objects. Human diagnostics go to stderr. Start the host
before the game or before sending requests; unsent requests wait for connection.
Give every new command a unique ID. After a disconnect or an unknown outcome,
retry the identical request with its SAME ID on the SAME browser session. Sent
actions are never replayed automatically. The last 256 receipts are retained;
do not reuse an old ID or retry an unknown action with a new ID.

Example: printf '%s\\n' '{"v":1,"id":"obs-1","op":"observe"}' | ./scripts/automation-host.sh
`;
}

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.origin === HOSTED_ORIGIN && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash) return HOSTED_ORIGIN;
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use https://poker.gl.ax or an exact http:// loopback origin without a path or credentials.');
  }
  return url.origin;
}

function options(argv) {
  const result = { origins: new Set(DEFAULT_ORIGINS), stayOpen: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return null;
    if (argv[i] === '--stay-open') result.stayOpen = true;
    else if (argv[i] === '--origin' && argv[i + 1]) {
      result.origins = new Set([loopbackOrigin(argv[++i])]);
    } else throw new Error('Unknown or incomplete option. Use --help.');
  }
  return result;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownKeys(value, allowed) {
  return record(value) && Object.keys(value).every(key => allowed.includes(key));
}

function validId(value) {
  return typeof value === 'string' ? /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    : Number.isSafeInteger(value) && value >= 0;
}

function idKey(value) {
  return `${typeof value}:${value}`;
}

// Bound nested input independently of the byte limit. No input supplies code,
// property accessors, executable callbacks, filesystem paths, or network targets.
function boundedJson(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 32 || ++budget.nodes > 8192) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  for (const item of Object.values(value)) {
    if (!boundedJson(item, depth + 1, budget)) return false;
  }
  return true;
}

function validRequest(value) {
  return ownKeys(value, ['v', 'id', 'op', 'args']) && value.v === 1
    && validId(value.id) && OPS.has(value.op) && boundedJson(value);
}

function validHello(value) {
  return ownKeys(value, ['v', 'event', 'protocol', 'capabilities', 'visibility', 'session'])
    && value.v === 1 && value.event === 'hello' && value.protocol === 'web-balatro-eval'
    && value.visibility === 'player' && typeof value.session === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.session)
    && Array.isArray(value.capabilities) && value.capabilities.length === 3
    && value.capabilities.includes('observe') && value.capabilities.includes('act')
    && value.capabilities.includes('describe');
}

function validResponse(value) {
  if (!ownKeys(value, ['v', 'id', 'ok', 'result', 'error']) || value.v !== 1
    || !validId(value.id) || !boundedJson(value)) return false;
  if (value.ok === true) return Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error');
  return value.ok === false && !Object.hasOwn(value, 'result')
    && ownKeys(value.error, ['code', 'message']) && typeof value.error.code === 'string'
    && Object.hasOwn(ERRORS, value.error.code) && value.error.message === ERRORS[value.error.code];
}

function errorResponse(id, code) {
  return { v: 1, id, ok: false, error: { code, message: ERRORS[code] } };
}

function run(config) {
  const pending = new Map();
  const receipts = new Map();
  const lineBuffer = Buffer.allocUnsafe(MAX_MESSAGE_BYTES + 1);
  let lineBytes = 0;
  let discardLine = false;
  let bufferedInput = null;
  let inputOffset = 0;
  let outputBlocked = false;
  let stdinClosed = false;
  let finalInputRead = false;
  let stopping = false;
  let peer = null;
  let lastSession = null;

  const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    response.end('This is a local WebSocket automation host, not a game server.\n');
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const heartbeat = setInterval(() => {
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) return;
    if (!peer.alive) peer.socket.terminate();
    else {
      peer.alive = false;
      peer.socket.ping();
    }
  }, 15_000);
  heartbeat.unref();

  function emit(value) {
    if (process.stdout.destroyed) return;
    if (process.stdout.writableLength > 1024 * 1024) {
      stop('output_backpressure', 1);
      return;
    }
    if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
      outputBlocked = true;
      process.stdin.pause();
    }
  }

  function retain(key, receipt) {
    receipts.delete(key);
    receipts.set(key, receipt);
    if (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
  }

  function complete(key, response, terminal) {
    const request = pending.get(key);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(key);
    retain(key, { identity: request.identity, wire: request.wire,
      session: request.sentSession ?? request.targetSession, response, terminal });
    emit(response);
    finishIfIdle();
  }

  function send(key, request, controller) {
    if (controller.socket.readyState !== WebSocket.OPEN) return;
    request.sentSession = controller.session;
    request.socket = controller.socket;
    controller.socket.send(request.wire, error => {
      if (error && pending.get(key) === request) {
        // send() cannot prove that the browser did not receive an action. Keep the
        // ID pending for an explicit same-session retry rather than replaying it.
        controller.socket.terminate();
      }
    });
  }

  function acceptRequest(wire) {
    let value;
    try { value = JSON.parse(wire); } catch { /* Report only a fixed public error. */ }
    if (!validRequest(value)) {
      if (record(value) && validId(value.id)) emit(errorResponse(value.id, 'invalid_request'));
      else emit({ v: 1, event: 'error', error: { code: 'invalid_request', message: ERRORS.invalid_request } });
      return;
    }
    const key = idKey(value.id);
    const identity = JSON.stringify(value);
    const existing = pending.get(key);
    if (existing) {
      if (existing.identity !== identity) emit(errorResponse(value.id, 'request_conflict'));
      else if (peer?.session && existing.sentSession === peer.session && existing.socket !== peer.socket) {
        send(key, existing, peer);
      }
      return;
    }
    const receipt = receipts.get(key);
    if (receipt?.identity !== undefined && receipt.identity !== identity) {
      emit(errorResponse(value.id, 'request_conflict'));
      return;
    }
    if (receipt?.session && receipt.session !== (peer?.session ?? lastSession)) {
      emit(errorResponse(value.id, 'session_changed'));
      return;
    }
    if (receipt?.terminal) {
      emit(receipt.response);
      return;
    }
    if (pending.size === MAX_PENDING) {
      emit(errorResponse(value.id, 'busy'));
      return;
    }
    const request = { id: value.id, identity, wire, socket: null, sentSession: null,
      targetSession: receipt?.session ?? lastSession, timer: null };
    request.timer = setTimeout(() => {
      const code = request.sentSession ? 'response_timeout' : 'no_browser';
      complete(key, errorResponse(request.id, code), false);
    }, RESPONSE_TIMEOUT_MS);
    pending.set(key, request);
    if (peer?.session) send(key, request, peer);
  }

  function readLine() {
    const bytes = lineBytes && lineBuffer[lineBytes - 1] === 13 ? lineBytes - 1 : lineBytes;
    if (bytes > MAX_MESSAGE_BYTES || !isUtf8(lineBuffer.subarray(0, bytes))) {
      emit({ v: 1, event: 'error', error: { code: 'invalid_request', message: ERRORS.invalid_request } });
    } else {
      const wire = lineBuffer.toString('utf8', 0, bytes).trim();
      if (wire) acceptRequest(wire);
    }
    lineBytes = 0;
  }

  function consumeInput() {
    while (bufferedInput && inputOffset < bufferedInput.length && !outputBlocked && !stopping) {
      const newline = bufferedInput.indexOf(10, inputOffset);
      const end = newline < 0 ? bufferedInput.length : newline;
      const length = end - inputOffset;
      if (!discardLine) {
        if (lineBytes + length > lineBuffer.length) {
          lineBytes = 0;
          discardLine = true;
          emit({ v: 1, event: 'error', error: { code: 'invalid_request', message: ERRORS.invalid_request } });
        } else {
          bufferedInput.copy(lineBuffer, lineBytes, inputOffset, end);
          lineBytes += length;
        }
      }
      inputOffset = end + (newline < 0 ? 0 : 1);
      if (newline >= 0) {
        if (!discardLine) readLine();
        discardLine = false;
      }
    }
    if (bufferedInput && inputOffset === bufferedInput.length) {
      bufferedInput = null;
      inputOffset = 0;
    }
    finishInput();
  }

  function finishInput() {
    if (!stdinClosed || bufferedInput || finalInputRead || outputBlocked) return;
    finalInputRead = true;
    if (!discardLine && lineBytes) readLine();
    finishIfIdle();
  }

  function finishIfIdle() {
    if (finalInputRead && pending.size === 0 && !config.stayOpen) stop('stdin_eof', 0);
  }

  function stop(reason, exitCode) {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    process.stdin.pause();
    clearInterval(heartbeat);
    for (const [key, request] of pending) {
      clearTimeout(request.timer);
      emit(errorResponse(request.id, 'host_stopped'));
      pending.delete(key);
    }
    console.error(`Automation host stopped (${reason}).`);
    if (peer) peer.socket.close(1001, 'Host stopped');
    sockets.close();
    server.close();
    server.closeAllConnections();
    const forceClose = setTimeout(() => {
      for (const socket of sockets.clients) socket.terminate();
    }, 1_000);
    forceClose.unref();
  }

  function rejectUpgrade(socket, status) {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => socket.destroy());
    const allowedHost = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(request.headers.host);
    if (stopping || outputBlocked) return rejectUpgrade(socket, '503 Service Unavailable');
    if (request.method !== 'GET' || request.url !== '/' || !allowedHost
      || request.socket.remoteAddress !== '127.0.0.1'
      || !config.origins.has(request.headers.origin)) return rejectUpgrade(socket, '403 Forbidden');
    if (peer) return rejectUpgrade(socket, '409 Conflict');
    sockets.handleUpgrade(request, socket, head, connection => {
      const controller = { socket: connection, session: null, alive: true };
      peer = controller;
      const helloTimer = setTimeout(() => connection.terminate(), 5_000);
      connection.on('pong', () => { controller.alive = true; });
      connection.on('error', () => { /* ws owns protocol errors; never print peer payloads. */ });
      connection.on('message', (bytes, isBinary) => {
        let value;
        try { if (!isBinary) value = JSON.parse(bytes.toString('utf8')); } catch { /* Reject below. */ }
        if (!controller.session) {
          if (!validHello(value)) return connection.close(1008, 'Invalid hello');
          clearTimeout(helloTimer);
          controller.session = value.session;
          lastSession = value.session;
          emit({ ...value, event: 'connected' });
          for (const [key, request] of pending) {
            if ((request.targetSession && request.targetSession !== controller.session)
              || (request.sentSession && request.sentSession !== controller.session)) {
              complete(key, errorResponse(request.id, 'session_changed'), false);
            } else if (!request.sentSession) send(key, request, controller);
          }
          return;
        }
        if (!validResponse(value)) return connection.close(1008, 'Invalid response');
        const key = idKey(value.id);
        const request = pending.get(key);
        if (request?.sentSession === controller.session && request.socket === controller.socket) complete(key, value, true);
        else {
          const receipt = receipts.get(key);
          if (!receipt || receipt.session !== controller.session) return connection.close(1008, 'Unknown response ID');
          if (!receipt.terminal) {
            retain(key, { ...receipt, response: value, terminal: true });
            emit({ v: 1, event: 'receipt_available', id: value.id, session: controller.session });
          }
        }
      });
      connection.on('close', () => {
        clearTimeout(helloTimer);
        if (peer === controller) peer = null;
        if (controller.session) emit({ v: 1, event: 'disconnected', session: controller.session, pending: pending.size });
        finishIfIdle();
      });
    });
  });

  process.stdin.on('data', chunk => {
    bufferedInput = chunk;
    inputOffset = 0;
    consumeInput();
  });
  process.stdin.on('end', () => {
    stdinClosed = true;
    finishInput();
  });
  process.stdin.on('error', () => stop('stdin_error', 1));
  process.stdout.on('error', () => stop('stdout_error', 1));
  process.stdout.on('drain', () => {
    outputBlocked = false;
    consumeInput();
    if (!stopping && !stdinClosed) process.stdin.resume();
  });
  process.on('SIGINT', () => stop('interrupt', 0));
  process.on('SIGTERM', () => stop('terminate', 0));
  server.on('clientError', (_error, socket) => rejectUpgrade(socket, '400 Bad Request'));
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Local port ${PORT} is already in use.` : 'Cannot start the loopback automation host.');
    stop('server_error', 1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    emit({ v: 1, event: 'listening', url: `ws://127.0.0.1:${PORT}/`, origins: [...config.origins] });
  });
}

try {
  const config = options(process.argv.slice(2));
  if (config) run(config);
  else process.stdout.write(help());
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cannot start the automation host.');
  process.exitCode = 1;
}
