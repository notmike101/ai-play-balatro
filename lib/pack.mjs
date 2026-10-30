/* pack.mjs — booster-offer valuation: score one offered item for take/skip against
   the run state. Bar: callers take strictly above 3 (s > bs with bs = 3). */

import { PLANET_NAME, PLANET_GRIND } from './planets.mjs';
import { JUNK_JOKER, jokerTier, classifyJoker } from './jokers.mjs';

// money/utility tarots and safe spectrals usable without card targets (pack valuation table)
const TAROT_AUTO = [
    [/high priestess/i, 'two planets'],
    [/emperor/i, 'money cards'],
    [/judgement/i, 'money for joker'],
    [/tower(?! the)/i, 'stone card'],
    [/hierophant|lover/i, 'boost card'],
    [/wheel of fortune/i, 'joker edition roll'],
    [/hermit/i, 'money x2'],
];
const SPECTRAL_AUTO = [
    [/immolate/i, 'burn 5 +$20'],
    [/soul/i, 'rare jokers'],
    /* black hole IN: +1 level to EVERY poker hand incl undiscovered - confirmed build
       truth by user 10-29 (my vanilla 'levels to 1' recall was wrong; an earlier
       'unknown' note said the same). 28 sightings/0 takes so far: focal planets score
       30 > spectral 6, so it only wins a paid pack once scored above the focal tier
       (it subsumes focal +1) - first live use must show the lvlMap all-fam jump */
    [/black ?hole/i, 'all hands +1 level'],
    /* hex OUT: the build Hex wrecked our OWN lineup — Lusty+Joker+Baron dropped to
       lone Lusty at blind select right after the auto-use of the taken Hex (run
       1793031744, died a3 Arm 2044 short with a one-joker engine) */
    [/tarmigan/i, 'utility'],
];

/**
 * Score one booster-pack offer for take/skip against the run strategy.
 *
 * @param {object} [o] - pack offer item (kind/planet/tarot/card shapes)
 * @param {object} [ctx] - {fam, needFam, suit, levels, played} run state for valuation
 * @returns {number} score; callers take strictly above 3 (bar is s > bs with bs = 3)
 */
function scorePackOffer(o, ctx = {}) {
    switch (String(o?.kind ?? '').toLowerCase()) {
        case 'joker': {
            const t = JUNK_JOKER.test(o?.name || '') ? 0 : jokerTier(o?.name);
            return (classifyJoker(o).famHint === ctx.fam ? 14 : 5) + t;
        }
        case 'planet': {
            const f = Object.entries(PLANET_NAME).find(([, n]) => n === o?.name)?.[0];

            if (f === ctx.fam || f === ctx.needFam) {
                return 30;
            }

            /* non-target planets need play evidence on a GRINDABLE fam; unplayed
               high-BASE fams (Pluto->SF picked over 3-play TP, Neptune/SF while TP
               led) are the classic trap: the level raises model EV, play follows the
               level, the fam still never closes — base strength alone never mints a
               target. 1-2 plays clear the take bar at 4; 3+/5+/8+ plays escalate the
               tie-break so filler levels land on the families we ACTUALLY grind
               (run 1793030565 last mega: Saturn 4-play Straight tied Mercury 8-play
               Two Pair at 4 and won by offer order, focal TP stayed L2; run
               1793032315: TP with 1 lifetime play banked two Uranus levels) */
            const played = ctx.played?.[f] ?? 0;

            /* no level ceiling: hands level past L7 for free in this build (3402 ran Pair
               to L11) - a filler planet on a L5+ grind fam scores like any other */
            if (!(played >= 1 && PLANET_GRIND.has(f))) {
                return 3;
            }

            /* FOCAL-FIRST (168: five level actions, four families, focal Pair stuck at L2
               into The Wall - multi-pick packs ate every filler planet while the grinding
               fam starved; same ladder formula as the shop floor, filler levels measured
               near-zero below the focal wall) */
            const fp = ctx.played?.[ctx.needFam] ?? 0;
            const fl = ctx.levels?.[ctx.needFam] ?? 1;

            if (fp >= 5 && fl < Math.min((ctx.ante ?? 0) >= 5 ? 8 : 4, 1 + Math.floor(fp / 4))) {
                return 3;
            }

            return played >= 8 ? 4.6 : played >= 5 ? 4.3 : played >= 3 ? 4.1 : 4; /* eslint-disable-line no-nested-ternary */
        }
        case 'tarot':
            /* Lovers is unusable dead stock in this build (see tarot.mjs planTargeted gate) - score at
               the skip bar so it stops eating consumable slots out of packs */
            if (/lovers/i.test(`${o?.name} ${o?.key}`)) {
                return 3;
            }

            return TAROT_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 8 : 4;
        case 'spectral':
            /* Black Hole beats even a focal planet (30): +1 EVERY hand ⊃ +1 focal, so
               in a paid one-pick pack it must win the head-to-head it historically
               lost 0/28 to focal planets (user-confirmed +1-all, 10-29) */
            if (/black ?hole/i.test(`${o?.name} ${o?.key}`)) {
                return 32;
            }

            return SPECTRAL_AUTO.some(([re]) => re.test(`${o?.name} ${o?.key}`)) ? 6 : 3;
        /* STANDARD-pack contents arrive as BARE enhancement items with no rank
           ('Glass Card','Mult','Lucky Card','Stone Card','Default Base') and fell to
           the rank-less default score 1 — 9 Enhanced contents were offered across the
           corpus and ZERO were taken (only the 7 plain 'Default Base' strays got
           picked up by a different path). Taking an enhancer adds a random base card
           with that enhancement (Default Base proved the take path works); permanent
           enhancements are pure upside even though the bridge hides enh state from
           prediction — Steel never breaks, Glass/Mult scale every hand that draws
           them; Stone can never be SELECTED, so it is dead weight, stay at 1 */
        case 'enhanced': {
            const n = String(o?.name ?? '').toLowerCase();

            if (/stone/.test(n)) {
                return 1;
            }

            if (/steel/.test(n)) {
                return 5;
            }

            if (/glass/.test(n)) {
                return 4.3;
            }

            if (/mult/.test(n)) {
                return 4.2;
            }

            return 4; /* lucky/bonus/wild/gold/round: positive-EV fillers */
        }

        default:
            break;
    }

    if (o?.rank !== undefined) {
        let s = 1;

        if (ctx.fam === 'Flush' && o.suit === ctx.suit) {
            s += 6;
        } else if (o.suit === ctx.suit) {
            s += 1.5;
        }

        if (o.rank === 'Ace') {
            s += 3;
        } else if (['King', 'Queen', 'Jack'].includes(o.rank)) {
            s += 2;
        }

        if ((o.enhancements ?? []).length > 0) {
            s += 2;
        }

        if (/seal/i.test(String(o.seal ?? ''))) {
            s += 2;
        }

        return s;
    }

    return 1;
}

export { scorePackOffer, TAROT_AUTO, SPECTRAL_AUTO };
