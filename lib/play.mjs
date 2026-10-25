// play.mjs — score prediction, calibration, subset evaluation, discard heuristics (pure, no link).
import { evalHand, combos, rv, CHIP, BASE_IDX, SUITS } from './eval.mjs';
import { jokerFactor } from './knowledge.mjs';

export function famBase(handsTable, fam) {
  const row = (handsTable || []).find(h => h.name === fam);
  if (row) return { chips: row.chips, mult: row.mult, level: row.level ?? 1, name: row.name };
  return { chips: BASE_IDX[fam]?.[0] ?? 10, mult: BASE_IDX[fam]?.[1] ?? 1, level: 1, name: fam };
}
export function predict(handsTable, fam, scoring) {
  const b = famBase(handsTable, fam);
  const chips = b.chips + scoring.reduce((s, c) => s + CHIP(rv(c)), 0);
  const mult = b.mult * (jokerFactor[fam] ?? 1);
  return { chips, mult, score: Math.round(chips * mult) };
}
export function calibrate(fam, scoring, baseChips, baseMult, delta) {
  const exp = (baseChips + scoring.reduce((s, c) => s + CHIP(rv(c)), 0)) * baseMult;
  if (exp > 0 && delta > 0) {
    const f = Math.min(600, Math.max(1, delta / exp));
    jokerFactor[fam] = jokerFactor[fam] ? jokerFactor[fam] * 0.5 + f * 0.5 : f;
  }
}
export function normalizeHand(cards) { // face-down cards (The Mark/House): obs rank is null → rv 0 → fake "Pair" pred 20. Give each a distinct middling rank+suit as EV approximation.
  const R = [8, 9, 10, 12, 14]; let k = 0;
  return cards.map(c => (c.rank == null || c.rank === '') ? { ...c, rank: R[k % 5], suit: SUITS[k++ % 4], faceDown: true } : c);
}
export function allSubsetEvals(handCards, handsTable) {
  const playable = normalizeHand(handCards).filter(c => !c.debuff && (c.actions || []).includes('select'));
  const out = [];
  for (let k = 1; k <= Math.min(5, playable.length); k++)
    for (const cs of combos(playable, k)) {
      const e = evalHand(cs);
      out.push({ cards: cs, ...e, pred: predict(handsTable, e.fam, e.scoring).score });
    }
  out.sort((a, b) => b.pred - a.pred || a.cards.length - b.cards.length); // near-ties: play FEWEST cards (kickers score 0; fewer cards hit by debuff bosses)
  return out;
}

// ---------- discard keep heuristic ----------
export function drawScore(cs) { // cs = intended scoring/hold 1..5 cards
  const e = evalHand(cs);
  let s = { 'Straight Flush': 5e6, 'Four of a Kind': 4e5, 'Full House': 3.5e5, Flush: 3e5, Straight: 2e5, 'Three of a Kind': 1.5e5, 'Two Pair': 4e4, Pair: 1e4, 'High Card': 0 }[e.fam] || 0;
  return s + e.scoring.reduce((t, c) => t + CHIP(rv(c)), 0);
}
export function chooseDiscard(handCards, bestPlay, lock) { // lock: family locked by Eye/Mouth boss (or null)
  handCards = normalizeHand(handCards);
  const cards = handCards.filter(c => !c.debuff && (c.actions || []).includes('select'));
  if (lock) {
    const keyOf = c => lock === 'Flush' ? c.suit : c.rank;
    const cnt = {}; for (const c of cards) cnt[keyOf(c)] = (cnt[keyOf(c)] || 0) + 1;
    const keep = [...cards].sort((a, b) => cnt[keyOf(b)] - cnt[keyOf(a)] || rv(b) - rv(a)).slice(0, 5);
    const ki = new Set(keep.map(c => c.id));
    const dl = cards.filter(c => !ki.has(c.id));
    if (dl.length) return dl.slice(0, 5);
  }
  // hold candidates: best 5-card draw base by drawScore
  const five = handCards.length >= 5 ? combos(handCards, 5) : [handCards];
  let best = null;
  for (const f of five) { const s = drawScore(f); if (!best || s > best.s) best = { s, f }; }
  const keepIds = new Set(best.f.map(c => c.id));
  const disc = cards.filter(c => !keepIds.has(c.id));
  if (disc.length === 0) { // nothing to cut: dump single lowest junk that isn't in best pair
    const worst = [...cards].sort((a, b) => rv(a) - rv(b))[0]; return [worst];
  }
  return disc.slice(0, 5);
}
