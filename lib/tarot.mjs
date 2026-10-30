/* tarot.mjs — targeted (card-selecting) tarot planning + hand suit helper.
   Pure: given a hand-phase observation, name the consumable + cards to select. */

/**
 * Dominant suit in hand for flush-building picks (obs.hand only; null when unknown).
 *
 * @param {object} [obs] - current observation
 * @returns {(string|null)} suit name when at least 3 share it, else null
 */
function dominantSuit(obs) {
    const cnt = {};

    for (const c of Array.isArray(obs?.hand) ? obs.hand : []) {
        if (c?.suit) {
            cnt[c.suit] = (cnt[c.suit] ?? 0) + 1;
        }
    }

    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];

    return top && top[1] >= 3 ? top[0] : null;
}

const RANKV = { Ace: 14, A: 14, King: 13, K: 13, Queen: 12, Q: 12, Jack: 11, J: 11 };

/**
 * Numeric rank value for a card (0 for unknown/face-down).
 *
 * @param {object} c - card observation
 * @returns {number} 2..14 or 0
 */
function rvOf(c) {
    const n = Number(c && c.rank);

    if (!Number.isNaN(n)) {
        return n;
    }

    return RANKV[c && c.rank] ?? 0;
}

const SUIT_BY_TAROT = [['star', 'Diamonds'], ['moon', 'Clubs'], ['sun', 'Hearts'], ['world', 'Spades']];
const TARGET_RULES = [
    [/magician|empress|hierophant/i, 'top2'],
    [/tower/i, 'worst1'],
    [/devil/i, 'worst1'],
    [/chariot|justice|lovers|strength/i, 'best1'],
    [/hanged/i, 'trim2'],
];

/**
 * Target suit of a suit-conversion tarot (Star/Moon/Sun/World convert up to 3 selected cards;
 * NO submenu - the tarot fixes the suit). Effect text wins over the name map when present.
 *
 * @param {object} c - consumable observation
 * @param {string} nm - combined name+key string
 * @returns {string|null} suit name or null when not a suit tarot
 */
function suitTarget(c, nm) {
    const m = `${c.text || c.effect || ''}`.match(/diamonds|clubs|hearts|spades/i);

    if (m) {
        return m[0][0].toUpperCase() + m[0].slice(1).toLowerCase();
    }

    for (const [k, s] of SUIT_BY_TAROT) {
        if (new RegExp(`(^|[^a-z])${k}([^a-z]|$)`, 'i').test(nm)) {
            return s;
        }
    }

    return null;
}

/**
 * Descending-hand Death anchor: pick the right-most card of the highest duplicated
 * rank (all-distinct hands fall back to any card with a higher card on its left),
 * then the cheapest strictly-higher left card that Death should turn into it.
 *
 * @param {object[]} cards - selectable hand cards in table order
 * @returns {object[]|null} [left, right] or null when nothing qualifies
 */
function deathDescPair(cards) {
    const cnt = {};

    for (const c2 of cards) {
        cnt[rvOf(c2)] = (cnt[rvOf(c2)] || 0) + 1;
    }

    const dupRvs = Object.keys(cnt).map(Number).filter((r2) => cnt[r2] >= 2).sort((a, b) => b - a);

    for (let i = cards.length - 1; i >= 1; i--) {
        const right = cards[i];

        if (dupRvs.length && dupRvs[0] !== rvOf(right)) {
            continue;
        }

        const lefts = cards.slice(0, i).filter((x) => rvOf(x) > rvOf(right)).sort((a, b) => rvOf(a) - rvOf(b));

        if (lefts.length) {
            return [lefts[0], right];
        }
    }

    return null;
}

/**
 * One targeted direct-use tarot play for the current hand: caller selects cards then uses.
 * Table-driven: Magician/Empress/Hierophant top2 (Lucky/Mult/Bonus), Tower+Devil worst1
 * (Stone +50 / Gold money), Chariot(Steel)/Justice(Glass)/Lovers(Wild)/Strength(+1 rank) best1,
 * Hanged Man trims 2 junk (>=4 cards), Death needs a weaker card physically LEFT of the best
 * (left becomes copy of right by HAND position), Star/Moon/Sun/World convert up to 3 lowest
 * off-suit cards to the fixed suit. Suit commitment: once suitTally shows a committed suit
 * (>=2 conversions), non-matching converters are skipped so suits never oscillate back.
 *
 * @param {object} obs - hand-phase observation
 * @param {object} [suitTally] - this run's conversion counts per suit
 * @returns {object[]} at most one {target, cards, why} plan
 */
function planTargeted(obs, suitTally = {}) {
    /* Joker-target tarots: the card-target machinery below cannot express
       them. The Lovers copies a joker in most builds; 21+ Lovers holdings
       idled forever. Ankh (destroys the target joker) and Mothman are NOT
       safe guesses here, so only Lovers gets the flow. Use on the best
       scoring joker when a slot stands open. */
    /* Lovers in this build exposes only [sell/inspect] in every observed state and never
       copies passively at blind select or round end (3411: two rounds cleared, no duplicate)
       - gate on a real 'use' action so the branch stops firing 31x action_unavailable.
       If some future state grants 'use', the copy flow revives untouched. */
    const jkt = ((obs && obs.consumables) || []).find((c) => String(c.kind || '').toLowerCase() === 'tarot' && !c.face_down && !c.debuffed && (c.actions || []).includes('use') && /^(the lovers)$/i.test(c.name || ''));

    const jks = (obs && (obs.jokers || obs.jk)) || [];

    if (jkt && jks.length >= 2 && jks.length < 5) {
        const top = [...jks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];

        if (top) {
            return [{ target: jkt.id, jid: top.id, why: `jkcopy ${jkt.name}->${top.name}` }];
        }
    }

    const cards = ((obs && obs.hand) || []).filter((c) => !c.debuffed && (c.actions || []).includes('select') && c.rank !== null && c.rank !== undefined && c.rank !== '');

    if (cards.length < 2) {
        return [];
    }

    const cons = ((obs && obs.consumables) || []).filter((c) => String(c.kind || '').toLowerCase() === 'tarot' && !c.face_down && !c.debuffed && ((c.actions || []).includes('use') || (c.actions || []).includes('inspect')));
    const byRv = [...cards].sort((a, b) => rvOf(b) - rvOf(a));
    const suitCount = {};

    for (const c0 of cards) {
        const s0 = `${c0.suit || ''}`;

        if (s0) {
            suitCount[s0] = (suitCount[s0] || 0) + 1;
        }
    }

    const topSuit = Object.entries(suitCount).sort((a, b) => b[1] - a[1])[0];
    const flushSuit = topSuit && topSuit[1] >= 4 ? topSuit[0] : null;
    let plan = null;

    for (const c of cons) {
        const nm = `${c.name || ''} ${c.key || ''}`;

        if (/wheel/i.test(nm)) {
            // untargeted: planConsumables uses it; selecting cards for it is noise
            continue;
        }

        const suit = suitTarget(c, nm);

        if (suit) {
            const commit = Object.entries(suitTally).sort((a, b) => b[1] - a[1])[0];

            if (commit && commit[1] >= 2 && suit !== commit[0]) {
                continue;
            }

            const off = cards.filter((x) => `${x.suit || ''}`.toLowerCase() !== suit.toLowerCase()).sort((a, b) => rvOf(a) - rvOf(b)).slice(0, 3);

            if (off.length) {
                plan = { target: c.id, cards: off, why: `suit->${suit}` };
                break;
            }

            continue;
        }

        if (/death/i.test(nm)) {
            /* DEATH-CLONE v3 (deathdiag capture 1793077710: hands arrive rank-DESCENDING
               and v2's "weaker card left of stronger" scan found no pair on ANY real hand
               - 19+ idled holds across 75486/7709). Death copies the RIGHT card onto the
               LEFT positionally. First try the ascending case (weaker left promoted onto
               a stronger right); if the hand is descending, ANCHOR the duplicated rank
               (the focal pair/trips) and demote the cheapest strictly-higher left card
               into it: junk 4 next to a pair of 2s becomes a third 2. With all-distinct
               ranks the same rule pairs the 2nd-best card under the best (K,Q -> QQ). */
            let pair = null;

            for (const right of byRv) {
                const pi = cards.indexOf(right);
                const left = cards.slice(0, pi).filter((x) => rvOf(x) < rvOf(right)).pop();

                if (left) {
                    pair = [left, right];

                    break;
                }
            }

            if (!pair) {
                pair = deathDescPair(cards);
            }

            if (pair) {
                plan = { target: c.id, cards: pair, why: 'death leftcopy->best' };

                break;
            }

            continue;
        }

        for (const [re, mode] of TARGET_RULES) {
            if (!re.test(nm)) {
                continue;
            }

            if (mode === 'top2' && byRv.length >= 2) {
                plan = { target: c.id, cards: byRv.slice(0, 2), why: 'enhance top 2' };
            } else if (mode === 'worst1') {
                plan = { target: c.id, cards: [byRv[byRv.length - 1]], why: 'stone/gold junk' };
            } else if (mode === 'best1') {
                /* Steel (Chariot) / Glass (Justice) boost the WHOLE scoring card: with a
                   flush-shape suit (>=4 cards) in hand, enhance that suit's best card -
                   a steel card outside the flush suit only scores in isolation */
                const steel = /chariot|justice/i.test(nm) && flushSuit;
                const pick = steel
                    ? cards.filter((x) => `${x.suit || ''}`.toLowerCase() === `${flushSuit}`.toLowerCase()).sort((a, b) => rvOf(b) - rvOf(a))[0] || byRv[0]
                    : byRv[0];

                plan = { target: c.id, cards: [pick], why: steel && pick !== byRv[0] ? 'enhance best flushsuit' : 'enhance best' };
            } else if (mode === 'trim2' && cards.length >= 4) {
                plan = { target: c.id, cards: byRv.slice(-2), why: 'trim 2 junk' };
            }

            break;
        }

        if (plan) {
            break;
        }
    }

    return plan ? [plan] : [];
}

export { dominantSuit, rvOf, suitTarget, planTargeted };
