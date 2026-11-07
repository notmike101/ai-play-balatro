/* tools/hact.mjs - one-shot relay op helper for reasoning-driven play (auto fresh epoch).
   usage: node tools/hact.mjs <cmd> [arg] - cmds: obs | act <json> | play <ids> | discard <ids> | ctl <kind> */
import fs from 'node:fs';

const RESP = 'out/hostresp.log';
const CMD = 'out/hostcmd.json';

/**
 * Sleep helper.
 *
 * @param {number} ms - delay in milliseconds
 * @returns {Promise<void>} resolves after the delay
 */
function sleep(ms) {
    return new Promise((res) => {
        setTimeout(res, ms);
    });
}

/**
 * Unique request id.
 *
 * @returns {string} request id
 */
function rid() {
    return `h${Date.now().toString(36)}${Math.floor(Math.random() * 10_000).toString(36)}`;
}

/**
 * Append one op to the relay file and wait for the matching reply id.
 *
 * @param {object} o - op envelope {v,id,op,args}
 * @returns {Promise<object>} parsed response row
 */
async function send(o) {
    fs.appendFileSync(CMD, `${JSON.stringify(o)}\n`);
    const t0 = Date.now();

    while (Date.now() - t0 < 25_000) {
        await sleep(150);
        const L = fs.readFileSync(RESP, 'utf8').split('\n').filter(Boolean);

        for (let i = L.length - 1; i >= 0; i--) {
            let j;

            try {
                j = JSON.parse(L[i]);
            } catch {
                continue;
            }

            if (j.id === o.id) {
                return j;
            }
        }
    }

    return { ok: false, error: { code: 'timeout', message: o.id } };
}

/**
 * Compact state view of a response (ids are observation-local - rescan before every act).
 *
 * @param {object} r - response row
 * @returns {object} summary fields
 */
function view(r) {
    const x = r.result;

    if (!x) {
        return { err: r.error };
    }

    return {
        epoch: x.epoch,
        phase: x.phase,
        money: x.run?.money,
        roundScore: x.run?.chips,
        hands: x.run?.hands_left,
        discards: x.run?.discards_left,
        over: x.run?.game_over,
        won: x.run?.won,
        ante: x.run?.ante,
        target: x.run?.blind?.target,
        boss: x.run?.blind?.name,
        hand: (x.hand ?? []).map((c) => `${c.id}:${c.rank}${c.suit?.[0] ?? ''}${c.debuffed ? '*' : ''}`),
        levels: (x.hands ?? []).filter((h) => h.level > 1).map((h) => `${h.name}L${h.level}`),
        shop: (x.shop ?? []).map((c) => `${c.id}:${c.name}$${c.cost}${c.actions?.includes('buy') ? '' : '(x)'}`),
        cons: (x.consumables ?? []).map((c) => `${c.id}:${c.name}`),
        jokers: (x.jokers ?? []).map((c) => `${c.slot}:${c.name}`),
        pack: (x.pack ?? []).map((c) => `${c.id}:${c.name} ${(c.effect ?? []).join(' ')}`),
        controls: (x.controls ?? []).filter((c) => c.enabled).map((c) => `${c.id}:${c.kind}`),
        err: r.ok === false ? r.error : undefined,
    };
}

/**
 * Fresh observation (for epoch + current ids).
 *
 * @returns {Promise<object>} observation result
 */
async function fresh() {
    const r = await send({ v: 1, id: rid(), op: 'observe' });

    return r.result ?? { epoch: -1 };
}

/**
 * Run one act op with fresh epoch, retrying once on stale_observation.
 *
 * @param {object} args - act args without epoch
 * @returns {Promise<object>} response row
 */
async function act(args) {
    const o = await fresh();
    let r = await send({ v: 1, id: rid(), op: 'act', args: { epoch: o.epoch, ...args } });

    if (r.error?.code === 'stale_observation') {
        const o2 = await fresh();

        r = await send({ v: 1, id: rid(), op: 'act', args: { epoch: o2.epoch, ...args } });
    }

    return r;
}

/**
 * Select cards then press the enabled play/discard control.
 *
 * @param {number[]} ids - card ids to highlight
 * @param {string} kind - 'play' or 'discard'
 * @returns {Promise<object>} response row after activating the control
 */
async function playOrDiscard(ids, kind) {
    const r = await act({ action: 'select', cards: ids });

    if (!r.ok) {
        return act({ action: kind, cards: ids });
    }

    const ctlKind = kind === 'play' ? 'play_cards_from_highlighted' : 'discard_cards_from_highlighted';
    let ctl = (r.result.controls ?? []).find((c) => c.enabled && c.kind === ctlKind);
    let ep = r.result.epoch;

    if (!ctl) {
        const o2 = await fresh();

        ctl = (o2.controls ?? []).find((c) => c.enabled && c.kind === ctlKind);
        ep = o2.epoch;
    }

    if (!ctl) {
        return { ok: false, error: { code: 'no_ctl', message: ctlKind } };
    }

    return send({ v: 1, id: rid(), op: 'act', args: { epoch: ep, action: 'activate', target: ctl.id } });
}

/**
 * Activate an enabled control by kind with fresh epoch.
 *
 * @param {string} kind - control kind (cash_out, select_blind, ...)
 * @returns {Promise<object>} response row
 */
async function ctl(kind) {
    const o = await fresh();
    const c = (o.controls ?? []).find((x) => x.enabled && x.kind === kind);

    if (!c) {
        return { ok: false, error: { code: 'ctl_missing', message: `${kind} have:${(o.controls ?? []).map((x) => `${x.kind}:${x.enabled}`)}` } };
    }

    return send({ v: 1, id: rid(), op: 'act', args: { epoch: o.epoch, action: 'activate', target: c.id } });
}

const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
    case 'obs': {
        console.log(JSON.stringify(view(await send({ v: 1, id: rid(), op: 'observe' }))));

        break;
    }
    case 'act': {
        console.log(JSON.stringify(view(await act(JSON.parse(arg)))));

        break;
    }
    case 'play':
    case 'discard': {
        console.log(JSON.stringify(view(await playOrDiscard(arg.split(',').map(Number), cmd))));

        break;
    }
    case 'ctl': {
        console.log(JSON.stringify(view(await ctl(arg))));

        break;
    }

    default: {
        console.log(JSON.stringify({ err: { code: 'bad_cmd', cmd } }));
        process.exit(1);
    }
}
