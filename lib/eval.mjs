// eval.mjs — pure poker hand evaluation (no I/O, no game link).
export const RANKV = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, Jack: 11, Queen: 12, King: 13, Ace: 14, J: 11, Q: 12, K: 13, A: 14 };
export const rv = c => typeof c.rank === 'number' ? c.rank : (RANKV[c.rank] ?? 0);
export const SUITS = ['Hearts', 'Spades', 'Diamonds', 'Clubs'];
export const suitOf = c => typeof c.suit === 'string' ? c.suit : SUITS.find(s => (c.name || '').includes(s)) ?? '';
export const CHIP = v => v <= 10 ? v : (v === 14 ? 11 : 10); // rank chips: A=11, face=10
export const FAM_ORDER = ['Straight Flush', 'Four of a Kind', 'Full House', 'Flush', 'Straight', 'Three of a Kind', 'Two Pair', 'Pair', 'High Card'];
export const BASE_IDX = { 'High Card': [5, 1], 'Pair': [10, 2], 'Two Pair': [20, 2], 'Three of a Kind': [30, 3], 'Straight': [30, 4], 'Flush': [35, 4], 'Full House': [40, 4], 'Four of a Kind': [60, 7], 'Straight Flush': [100, 8] };

export function evalHand(cs) { // cs: 1..5 cards -> {fam, scoring:[]}
  const n = cs.length, vals = cs.map(rv).sort((a, b) => a - b);
  const suits = cs.map(suitOf);
  const byVal = {}; cs.forEach((c, i) => (byVal[vals[i]] ??= []).push(cs.find(x => rv(x) === vals[i])));
  const cnt = {}; vals.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  const groups = Object.entries(cnt).sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = n === 5 && suits.every(s => s === suits[0]);
  const u = [...new Set(vals)];
  let straightHigh = 0;
  if (n === 5 && u.length === 5) {
    if (u[4] - u[0] === 4) straightHigh = u[4];
    if (u.join(',') === '2,3,4,5,14') straightHigh = 5;
  }
  const of = k => groups.filter(g => g[1] >= k).map(g => +g[0]);
  if (flush && straightHigh) return { fam: 'Straight Flush', scoring: cs };
  if (groups[0][1] === 4) return { fam: 'Four of a Kind', scoring: byVal[groups[0][0]] };
  if (groups[0][1] === 3 && groups[1] && groups[1][1] === 2) return { fam: 'Full House', scoring: cs };
  if (flush) return { fam: 'Flush', scoring: cs };
  if (straightHigh) return { fam: 'Straight', scoring: cs };
  if (groups[0][1] === 3) return { fam: 'Three of a Kind', scoring: byVal[groups[0][0]] };
  if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) return { fam: 'Two Pair', scoring: [...byVal[groups[0][0]], ...byVal[groups[1][0]]] };
  if (groups[0][1] === 2) return { fam: 'Pair', scoring: byVal[groups[0][0]] };
  return { fam: 'High Card', scoring: [cs.reduce((a, c) => rv(c) > rv(a) ? c : a, cs[0])] };
}
export function combos(arr, k) { const out = []; const a = []; (function rec(i) { if (a.length === k) return out.push([...a]); for (let j = i; j < arr.length; j++) { a.push(arr[j]); rec(j + 1); a.pop(); } })(0); return out; }
