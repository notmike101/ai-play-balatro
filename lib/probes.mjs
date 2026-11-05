/* lib/probes.mjs — one-shot mechanics probes (extracted behavior-neutral from
   driver.mjs, audit wave driver-split 11-05): the reduced-motion Options probe
   that runs exactly once per boot at the first cash_out screen. */
import { jw } from './knowledge.mjs';
import { observe, act } from './link.mjs';

let done = false;

/**
 * Reduced-motion options probe, once per boot at the first cash_out screen.
 * The cash_out Options control lands on the nav overlay; real option rows live
 * one level deeper under Settings. Flips the motion toggle when the row is
 * readable, then backs out; when rows arrive label-less through the bridge it
 * only backs out - blind per-boot toggling would OSCILLATE the persisted save.
 *
 * @param {object} obs - cash_out-phase observation
 */
async function optionsProbe(obs) {
    const oc = (obs.controls || []).find((x) => x.kind === 'options' && x.enabled);

    if (!oc) {
        jw({ e: 'optprobe', noCtrl: true });

        return;
    }

    const ra = await act({ epoch: obs.epoch, action: 'activate', target: oc.id });

    if (!ra.ok) {
        jw({ e: 'optprobe', actFail: ra.error?.code });

        return;
    }

    try {
        let o2 = await observe();
        let rows = (o2.controls || []).map((x) => `${x.kind}:${x.id}:${String(x.label ?? '').slice(0, 34)}`);
        let rm = (o2.controls || []).find((x) => /reduced|motion|animation/i.test(String(x.label ?? '')));

        /* first probe hit MENU-style overlays (the cash_out Options ctrl
           lands on the nav overlay: settings:1:Settings...) - chain one
           level into Settings where the actual option rows live */
        if (!rm) {
            const st = (o2.controls || []).find((x) => x.kind === 'settings' || /^settings/i.test(String(x.label ?? '')));

            if (st && (await act({ epoch: o2.epoch, action: 'activate', target: st.id })).ok) {
                o2 = await observe();
                rows = (o2.controls || []).map((x) => `${x.kind}:${x.id}:${String(x.label ?? '').slice(0, 34)}`);
                rm = (o2.controls || []).find((x) => /reduced|motion|animation/i.test(String(x.label ?? '')));
            }
        }

        const toggled = [];

        if (rm) {
            toggled.push((await act({ epoch: o2.epoch, action: 'activate', target: rm.id })).ok ?? false);

            const o3 = await observe();
            const backs = (o3.controls || []).filter((x) => /^(back|close|exit|leave)/i.test(String(x.label ?? '').trim()) || x.kind === 'back' || x.kind === 'exit_overlay_menu');

            for (let b = 0; b < 2 && b < backs.length; b++) {
                await act({ epoch: (b ? await observe() : o3).epoch, action: 'activate', target: backs[b].id });
            }
        } else if ((o2.controls || []).some((x) => x.kind === 'change_tab')) {
            /* probe FROZEN log-only 11-05: Game-tab option rows are LABEL-LESS
               through the bridge (cycles show '<'/'>', booleans just
               'toggle_button'). One blind flip was made (button:9 ok; :10 missed
               on a stale epoch) and run cadence did NOT change (the 13/h dip was
               ops-restart churn, driver verified healthy mid-shop) - no more
               flips: per-boot toggling would OSCILLATE the persisted save. */
            const o4 = await observe();
            const bk = (o4.controls || []).find((x) => x.kind === 'options' || /^back/i.test(String(x.label ?? '')));

            if (bk) {
                await act({ epoch: o4.epoch, action: 'activate', target: bk.id });

                const o5 = await observe();
                const bk2 = (o5.controls || []).find((x) => x.kind === 'exit_overlay_menu' || /^back/i.test(String(x.label ?? '')));

                if (bk2) {
                    await act({ epoch: o5.epoch, action: 'activate', target: bk2.id });
                }
            }
        }

        jw({ e: 'optprobe', ctrls: rows, rmFound: rm === undefined ? 'no' : String(rm.label).slice(0, 40), toggled });
    } catch (e) {
        jw({ e: 'optprobe', err: String(e?.message ?? e).slice(0, 140) });
    }
}

/**
 * Run the reduced-motion probe if it has not run yet this boot.
 *
 * @param {object} obs - cash_out-phase observation
 * @returns {Promise<boolean>} true when the probe ran (caller must re-observe:
 *   the cash_out act needs a post-probe epoch)
 */
export async function maybeOptionsProbe(obs) {
    if (done) {
        return false;
    }

    done = true;
    await optionsProbe(obs);

    return true;
}
