/* lib/setup.mjs — New Run overlay driving (extracted behavior-neutral from driver.mjs,
   audit wave driver-split 11-05): deck/stake cycling against the live setup rows,
   game-range clamp, deck re-select, start click. Bookkeeping (rid, runstart log row,
   per-run resets) stays in the driver wrapper. */
import { jw, sleep, STAKE_LABELS } from './knowledge.mjs';
import { observe, act } from './link.mjs';

/**
 * Find the paired direction-cycle control for an option_cycle, falling back to itself.
 *
 * @param {object[]} all - all controls from the current observation
 * @param {object} c - the option_cycle control being rotated
 * @param {string} dir - wanted direction, 'l' or 'r'
 * @returns {object | null} matching enabled cycle control, or null
 */
export function cyclePartner(all, c, dir) {
    return all.find((x) => x.enabled && x.kind === 'option_cycle' && Array.isArray(x.options)
        && x.options.length === c.options.length && x.options[0] === c.options[0] && x.direction === dir)
    || (c.direction === dir ? c : null);
}

/**
 * Drive the New Run overlay rows to the wanted deck and stake, then press start.
 *
 * Proven overlay semantics (13-start loop 10-29): control indices are 1-based, the
 * STAKE row's options are numbers [1..8] (label probes never match), rows render a
 * tick late (hence the retry rounds), and the deck row must be re-asserted last.
 *
 * @param {object} obs - overlay-phase observation
 * @param {string} wantDeck - deck label from policy (e.g. 'Red Deck')
 * @param {number} stakeWant - ladder stake index (1-based)
 * @param {object} ctx - host callbacks
 * @param {(v: number) => void} ctx.noteCap - reports the highest stake the game's
 *   setup row exposes (options length), for the driver's cap cache + file
 * @returns {Promise<{kind: 'stuck' | 'startfail' | 'setupopen' | 'started', stakeLbl?: (string | null), hasCyc?: boolean}>}
 *   outcome of the overlay drive
 */
export async function runSetupOverlay(obs, wantDeck, stakeWant, ctx) {
    const unwon = STAKE_LABELS[Math.max(0, Math.min(7, stakeWant - 1))];
    let o = obs;

    for (let round = 0; round < 40; round++) {
        const cycles = (o.controls || []).filter((c) => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options));

        /* STAKE LOOP FORENSICS (10-30: 256 stakeaborts, game starts stake1 while
           runstart claims Red - fall-through-to-default start path suspected):
           capture EVERY overlay frame's control kinds + cycle states */
        jw({ e: 'ovl', round, ks: (o.controls || []).map((c) => `${c.kind}${c.enabled ? '' : '!'}${c.options ? `[${c.options.length}]@${c.index}{${c.options.slice(0, 5).join('/')}}` : `=${c.label ?? ''}`}`).join(';').slice(0, 700), run: Boolean(o.run) });

        /* Rows render a tick LATE on this overlay (observed 10-30: the first
           frame had NO option_cycle at all, so the old code broke straight to
           start and ran the game's DEFAULT stake - every claimed stake was
           fiction and the stake guard crash-looped on the White runs) */
        if (!cycles.length && round < 8) {
            await sleep(600);
            o = await observe();

            continue;
        }

        /* PROVEN against the live setup overlay (13-start loop 10-29): indices are
           1-based (deck index 1 == "Red Deck" = game default; stake index 1 == stake 1
           = game's stake 1) and the STAKE control's options are NUMBERS [1..8], not
           label strings - the old /stake/i label probe never matched, so the stake
           arrow was never clicked and every claimed stake was fiction */
        /**
         * Read an option label, compensating for the 1-based index reported by controls.
         *
         * @param {object} c - option_cycle control
         * @param {number} i - control-reported index
         * @returns {string} option label
         */
        // eslint-disable-next-line unicorn/consistent-function-scoping -- reads o.controls layout fresh per overlay
        const at = (c, i) => c.options[i - 1];
        const deckC = cycles.find((c) => c.options.some((s) => /deck/i.test(String(s))));
        const stakeC = cycles.find((c) => c !== deckC && c.options.length >= 2 && c.options.every((s) => {
            const v = Number(s);

            return Number.isInteger(v) && v >= 1 && v <= 8;
        }));
        /* DECK-STYLED STAKE ROW DISABLED (10-30, oracle-confirmed): the second
           deck-label cycle IS a deck selector - clicking its arrows cycles DECKS
           (the 18:4x "oscillating @1<->@2" was our own double-clicking), never the
           stake. The real stake cycle only exists when the game has >1 stake
           UNLOCKED; this build's save lost the White win, so setup shows NO stake
           row and PLAY serves White. Numeric-cycle branch above stays the live path */
        let c = null;
        let ti = -1;

        if (deckC && at(deckC, deckC.index) !== wantDeck) {
            c = deckC;
            ti = deckC.options.indexOf(wantDeck);
        } else if (stakeC) {
            const first = Number(at(stakeC, stakeC.index));
            const stakeCur = Number.isInteger(first) ? first : stakeC.index;

            /* GAME-RANGE CLAMP (10-31: after our wins.json grew Red, wantSt=3 but the
               setup row exposes only {1/2} - game save never recorded the Red win, so
               Green is LOCKED; findIndex(-1) fallback ti=stakeWant-1 then wrapped mod 2
               back onto index 0 = WHITE, silently downgrading every run while the guard
               abort-looped. Ladder may never exceed the game's unlocked options: take
               the highest unlocked instead of wrapping to White. */
            ctx.noteCap(stakeC.options.length);

            const stakeCapNow = Math.min(stakeWant, stakeC.options.length);

            if (stakeCur !== stakeCapNow) {
                c = stakeC;
                ti = stakeC.options.findIndex((s) => Number(s) === stakeCapNow);

                if (ti < 0) {
                    ti = stakeCapNow - 1;
                }
            }
        }

        if (!c || ti < 0) {
            break;
        }

        const n = c.options.length;
        const cur = ((c.index - 1 + n) % n);
        const delta = (ti - cur + n) % n;
        const useCtl = cyclePartner(o.controls, c, delta <= n / 2 ? 'r' : 'l');

        if (!useCtl) {
            break;
        }

        const r = await act({ epoch: o.epoch, action: 'activate', target: useCtl.id });

        if (!r.ok) {
            jw({ e: 'cyclefail', code: r.error?.code });
            break;
        }

        o = r.result;
    }

    /* DECK RE-SELECT (10-30 forensics): clicking the stake row's partner also flips
       the deck row (observed both cycles oscillating @1<->@2 in lockstep) - land the
       stake LAST and re-assert the wanted deck immediately before PLAY, else every
       second run starts Blue Deck (137447 rid 1793387361: stake arrows hit, deck lost) */
    {
        const deckC2 = (o.controls || []).find((c) => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options) && c.options.some((s) => /deck/i.test(String(s))));

        if (deckC2 && deckC2.options[deckC2.index - 1] !== wantDeck) {
            const ti2 = deckC2.options.indexOf(wantDeck);
            const dir2 = ti2 >= deckC2.index ? 'r' : 'l';
            const partner = cyclePartner(o.controls, deckC2, dir2);

            if (partner) {
                const rr = await act({ epoch: o.epoch, action: 'activate', target: partner.id });

                if (rr.ok) {
                    o = rr.result;
                }
            }
        }
    }

    const stakeCyc = (o.controls || []).find((c) => c.kind === 'option_cycle' && Array.isArray(c.options) && (c.options.some((s) => /stake/i.test(String(s))) || (c.options.length >= 2 && c.options.every((s) => {
        const v = Number(s);

        return Number.isInteger(v) && v >= 1 && v <= 8;
    }))));
    const rawStake = stakeCyc ? stakeCyc.options[stakeCyc.index - 1] : null;
    let stakeLbl = null;

    if (rawStake !== null && rawStake !== undefined) {
        stakeLbl = /stake/i.test(String(rawStake)) ? String(rawStake) : STAKE_LABELS[Number(rawStake) - 1] || null;
    }

    if (stakeLbl === null && stakeCyc) {
        /* deck-styled stake row (10-30 UI): options are deck labels, index is the stake */
        stakeLbl = STAKE_LABELS[stakeCyc.index - 1] ?? null;
    }

    const start = (o.controls || []).find((c) => c.enabled && /start_setup_run/.test(c.kind));

    if (!start) {
        /* PAUSE MENU (opened by the stake-abort guard): its New Run button (kind
           setup_run) opens the real setup tab with the deck/stake cycles +
           start_setup_run; the loop re-enters handleNewRun on that overlay */
        const sr = (o.controls || []).find((c) => c.enabled && c.kind === 'setup_run');

        if (sr) {
            jw({ e: 'setupopen' });
            await act({ epoch: o.epoch, action: 'activate', target: sr.id });

            return { kind: 'setupopen' };
        }

        jw({ e: 'overlaystuck', controls: (o.controls || []).map((c) => `${c.kind}:${c.label}`) });

        return { kind: 'stuck' };
    }

    const r = await act({ epoch: o.epoch, action: 'activate', target: start.id });

    if (!r.ok) {
        jw({ e: 'startfail', code: r.error?.code });

        return { kind: 'startfail' };
    }

    return {
        kind: 'started', stakeLbl: stakeLbl || unwon, hasCyc: Boolean(stakeCyc),
    };
}
