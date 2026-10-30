/* planetneed.mjs — planet TARGETING (which family a planet purchase should level) and
   GAMEFAM ATTRIBUTION (did the game really level what we bought, and through which
   family? proven by diffing hands-table level snapshots around each level-affecting act). */

import { buildFamilies, jw } from './knowledge.mjs';
import { PLANET_GRIND } from './planets.mjs';

/**
 * Return the hands-family row most worth leveling, or null for NO planet target.
 * With play evidence: most-played GRINDABLE family (ties -> strongest base). Before
 * evidence (max played < 2) nothing is targeted: SF/4ok/FH never close on the RED
 * profile and leveling them is a dead $4-6 (two window runs spent 5 levels there:
 * SF:3+3ok:2 with TP focal L1; Neptune/SF while TP led play).
 *
 * @param {(object[] | undefined)} handsTable - run hands table rows
 * @returns {(object | null)} row with f, lvl and played fields
 */
function nextPlanetNeed(handsTable) {
    const fams = buildFamilies();
    const rows = fams.map((f) => {
        const r = (handsTable || []).find((h) => h.name === f);

        return { f, lvl: r?.level ?? 1, played: r?.played ?? r?.times_played ?? 0 };
    });
    const usable = rows.filter((r) => r.lvl < 9 && PLANET_GRIND.has(r.f));
    const grindRows = rows.filter((r) => PLANET_GRIND.has(r.f));
    const maxP = grindRows.length ? Math.max(...grindRows.map((r) => r.played)) : 0;

    if (usable.length && maxP >= 2) {
        /* maxed most-played fam yields the fallback below: level 9 buys nothing and an
           unevidenced fallback fam is exactly the junk-planet failure this gate removes */
        const top = rows.filter((r) => r.played === maxP && PLANET_GRIND.has(r.f) && r.lvl < 9);

        if (top.length) {
            return top.sort((a, b) => fams.indexOf(a.f) - fams.indexOf(b.f))[0];
        }
    }

    /* FH LAST-RESORT (x5 anomaly census: 1793135563-era 612/617/619/620 + post-fix
       1793198413 — FH-dominant boards played FH 5-8x while no grindable family ever
       reached 2 plays, the play-led gate returned null ALL RUN, lvlAct 0 with empty
       lvlMaps every time, dead a3-a4 at FH-L1): when the board truly leads with FH
       (>=4 plays and >= any grind fam), Earth is the live planet — leveling what the
       board actually makes beats starving. TP-like boards keep grind targeting
       untouched (their lead fams clear the 2-play gate first). */
    const fh = rows.find((r) => r.f === 'Full House' && r.lvl < 9);

    if (fh && fh.played >= 4 && fh.played >= maxP) {
        return fh;
    }

    return null;
}

/* GAMEFAM ATTRIBUTION (user verify directive, 10-30): every level since the buy_and_use
   era arrives through the shop BUY or a pack PICK - zero consumable "use" rows, so the
   e:planet fam field (model's planetFam label) never tests the real mapping again.
   Snapshot levels before each level-affecting act; diff the result's hands table after.
   Pack-phase results may carry no hands table -> pending, attributed on the next shop
   observation that shows a level change (levels persist, so the join is honest). */
let lvPend = null;
const lvSnap = (obs) => Object.fromEntries(((obs && obs.hands) || []).map((h) => [h.name, h.level ?? 0]));

function noteLv(name, via, before, after) {
    if (!after || !after.length) {
        lvPend = { n: name, via, lv: before, ts: Date.now() };

        return null;
    }

    lvPend = null;
    const gf = after.filter((h) => (h.level ?? 0) > (before[h.name] ?? 0)).map((h) => h.name);
    jw({ e: 'gamefam', n: name, via, gamefam: gf.join('/') });

    return gf;
}

function flushLv(hands) {
    if (!lvPend || !hands || !hands.length) {
        return null;
    }

    /* a pack-phase pending must be attributed by the SAME shop visit (the loop
       re-observes within seconds); by the next shop a level change is far more
       likely from a consumable use during the blind, which its own probe logs */
    if (Date.now() - lvPend.ts > 90_000) {
        lvPend = null;

        return null;
    }

    const gf = hands.filter((h) => (h.level ?? 0) > (lvPend.lv[h.name] ?? 0)).map((h) => h.name);

    if (gf.length) {
        jw({ e: 'gamefam', n: lvPend.n, via: `${lvPend.via}+flush`, gamefam: gf.join('/') });
        lvPend = null;

        return gf;
    }

    return null;
}

/** Clear a stale pending level attribution (run reset). */
function resetPending() {
    lvPend = null;
}

export { nextPlanetNeed, lvSnap, noteLv, flushLv, resetPending };
