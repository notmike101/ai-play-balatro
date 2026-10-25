// shop.mjs — shop purchasing, booster packs, planet targeting.
import { observe, act } from './link.mjs';
import { policy, say, jw, jokerTier, buildFamilies, JUNK_JOKER } from './knowledge.mjs';

const tierOf = n => JUNK_JOKER.test(n || '') ? 0 : jokerTier(n); // junk counts as tier0 so swaps sell it first
export const FAM_BY_PLANET = { Pluto: 'High Card', Mars: 'Pair', Mercury: 'Two Pair', Jupiter: 'Flush', Venus: 'Straight', Saturn: 'Four of a Kind', Uranus: 'Straight Flush', Neptune: 'Three of a Kind', Earth: 'Full House' };
export const PLANET_NAMES = new Set(Object.keys(FAM_BY_PLANET));
const FAM_TEXT = [['straight flush', 'Straight Flush'], ['four of a kind', 'Four of a Kind'], ['full house', 'Full House'], ['three of a kind', 'Three of a Kind'], ['two pair', 'Two Pair'], ['high card', 'High Card'], ['flush', 'Flush'], ['straight', 'Straight'], ['pair', 'Pair']];
function famInText(t) { const s = String(t).toLowerCase(); for (const [k, f] of FAM_TEXT) if (s.includes(k)) return f; return null; }
export function planetFam(item) {
  const t = (item.effect || []).join(' ') + ' ' + (item.name || '');
  const byName = Object.entries(FAM_BY_PLANET).find(([p]) => t.toLowerCase().includes(p.toLowerCase()));
  return byName ? byName[1] : famInText(t);
}
export function nextPlanetNeed(handsTable) {
  const fams = buildFamilies();
  const rows = fams.map(f => { const r = (handsTable || []).find(h => h.name === f); return { f, lvl: r?.level ?? 1, played: r?.played ?? r?.times_played ?? 0 }; });
  const usable = rows.filter(r => r.lvl < 9);
  if (!usable.length) return null;
  const maxP = Math.max(...rows.map(r => r.played));
  if (maxP >= 2) return rows.filter(r => r.played === maxP).sort((a, b) => fams.indexOf(a.f) - fams.indexOf(b.f))[0];
  return usable[0];
}

export async function handlePackOpen(obs) { // standalone pack phase (booster already open at top level)
  const needFam = nextPlanetNeed(obs.hands)?.f ?? null;
  const best = pickPack(obs, needFam, obs);
  if (best) {
    const r = await act({ epoch: obs.epoch, action: 'use', target: best.id });
    if (r.ok) { say('pack: take', best.name || best.rank || '?'); return true; }
    jw({ e: 'packfail', what: best.name, code: r.error?.code });
  }
  const cl = (obs.controls || []).find(c => c.enabled && /skip|close|leave|next|exit/i.test(c.kind + ' ' + (c.label || '')));
  if (cl) await act({ epoch: obs.epoch, action: 'activate', target: cl.id });
  else jw({ e: 'packstuck', controls: (obs.controls || []).map(c => c.kind) });
  return true;
}
export async function handleShop(obs) {
  const pol = policy();
  const actions = []; const failed = new Set();
  const has = (it, a) => (it.actions || []).includes(a);
  const kind = it => String(it.kind || '').toLowerCase();
  let money = 0, loop = 0;
  while (loop++ < 16) {
    let o = await observe(); money = o.run?.money ?? 0;
    const items = (o.shop || []).filter(i => !failed.has(i.id));
    const jLimit = (o.areas || []).find(a => a.kind === 'jokers')?.limit ?? 5;
    const ownedJ = (o.jokers || []).length;
    const minTier = Math.min(9, ...(o.jokers || []).map(j => tierOf(j.name)));
    const needFam = nextPlanetNeed(o.hands)?.f ?? null;
    // 1) planets: instant level-up
    const isPl = i => (has(i, 'buy_and_use') || has(i, 'buy')) && planetFam(i);
    const pl = items.find(i => isPl(i) && planetFam(i) === needFam) || items.find(isPl); // grind the family we actually play; off-family only as filler
    if (pl) {
      const r = await act({ epoch: o.epoch, action: has(pl, 'buy_and_use') ? 'buy_and_use' : 'buy', target: pl.id });
      if (r.ok) { say('shop: planet', pl.name); actions.push('planet:' + pl.name); continue; }
      jw({ e: 'shopfail', what: pl.name, code: r.error?.code }); failed.add(pl.id); continue;
    }
    // 2) jokers when room, or upgrade-swap
    const jkFloor = (o.run?.ante ?? 1) >= 3 ? (pol.minHold ?? 8) : 0; // ante3+: bank money for interest ($1/$5, cap $20) before discretionary joker spend
    const jk = money >= jkFloor ? items.find(i => kind(i) === 'joker' && !JUNK_JOKER.test(i.name || '') && has(i, 'buy') && (ownedJ < jLimit || (tierOf(i.name) === 2 && minTier < 2))) : null;
    if (jk) {
      const r = await act({ epoch: o.epoch, action: 'buy', target: jk.id });
      if (r.ok) { say('shop: joker', jk.name); actions.push('joker:' + jk.name); continue; }
      // slots full: sell the single weakest owned joker, then retry the buy once
      if (ownedJ >= jLimit && tierOf(jk.name) > minTier) {
        const weak = (o.jokers || []).filter(j => (j.actions || []).includes('sell')).sort((a, b) => tierOf(a.name) - tierOf(b.name))[0];
        if (weak) {
          const o2 = await observe();
          const rs = await act({ epoch: o2.epoch, action: 'sell', target: weak.id });
          if (rs.ok) { say('shop: sell', weak.name, 'for', jk.name); actions.push('sell:' + weak.name); continue; }
        }
      }
      jw({ e: 'shopfail', what: jk.name, code: r.error?.code }); failed.add(jk.id); continue;
    }
    // 3) vouchers we like ('use' redeems)
    const vlist = pol.vouchers || ['Telescope', 'Overstock', 'Clearance Sale', "Director's Cut", 'Retcon', 'Grabber', 'Seed Money', 'Crystal Ball', 'Hone', 'Warp Time'];
    const vc = items.find(i => kind(i) === 'voucher' && (has(i, 'use') || has(i, 'buy')) && vlist.some(v => (i.name || '').includes(v)));
    if (vc) {
      const r = await act({ epoch: o.epoch, action: has(vc, 'use') ? 'use' : 'buy', target: vc.id });
      if (r.ok) { say('shop: voucher', vc.name); actions.push('voucher:' + vc.name); continue; }
      jw({ e: 'shopfail', what: vc.name, code: r.error?.code }); failed.add(vc.id); continue;
    }
    // 4) booster packs: 'use' = buy+open (costs money)
    const pk = items.find(i => kind(i) === 'booster' && has(i, 'use') && wantPack(i, o));
    if (pk) {
      const r = await act({ epoch: o.epoch, action: 'use', target: pk.id });
      if (r.ok) {
        actions.push('pack:' + pk.name);
        let po = r.result;
        for (let p2 = 0; p2 < 6; p2++) {
          const best = pickPack(po, needFam, o);
          if (!best) break;
          const rp = await act({ epoch: po.epoch, action: 'use', target: best.id });
          if (!rp.ok) { jw({ e: 'packfail', code: rp.error?.code }); break; }
          actions.push('take:' + (best.name || best.rank || '?')); po = rp.result;
          if (!(po.pack || []).length && po.phase !== 'pack') break;
        }
        const cl = (po.controls || []).find(c => c.enabled && /skip|close|leave|next|exit/i.test(c.kind + (c.label || '')));
        if (cl) await act({ epoch: po.epoch, action: 'activate', target: cl.id });
        continue;
      }
      jw({ e: 'shopfail', what: pk.name, code: r.error?.code }); failed.add(pk.id); continue;
    }
    // 5) reroll only while rich and still hunting planets
    const rr = (o.controls || []).find(c => c.enabled && /reroll/i.test(c.kind));
    const pB = actions.filter(a => a.startsWith('planet')).length;
    if (rr && money >= (pol.rerollMin ?? 16) && pB < 3) {
      const r = await act({ epoch: o.epoch, action: 'activate', target: rr.id });
      if (r.ok) { actions.push('reroll'); continue; }
    }
    jw({ e: 'shopdump', money, items: (o.shop || []).map(i => ({ k: i.kind, n: i.name, a: i.actions })) });
    break;
  }
  jw({ e: 'shopdone', money, actions });
  return { actions, obs: await observe() };
}
function wantPack(item, obs) {
  const n = (item.name || '') + (item.effect || []).join(' ');
  const m = obs.run?.money ?? 0;
  if (/Celestial/i.test(n)) return m >= 4;
  if (/Buffoon/i.test(n)) return m >= 5;
  if (/Standard/i.test(n)) return (obs.run?.ante ?? 1) >= 3 && m >= 7;
  if (/Arcana/i.test(n)) return m >= 9 && (obs.run?.ante ?? 1) >= 3;
  if (/Spectral/i.test(n)) return m >= 10;
  return false;
}
function packOffers(po) {
  const p = po.pack;
  if (Array.isArray(p)) return (p.length && Array.isArray(p[0]?.offers)) ? p[0].offers : p;
  if (p && Array.isArray(p.offers)) return p.offers;
  return [];
}
function pickPack(po, needFam, obs) {
  const offers = packOffers(po).filter(o => o && typeof o === 'object' && (o.actions || []).includes('use'));
  let best = null, bs = 4;
  for (const o of offers) {
    const k = String(o.kind || '').toLowerCase();
    let s = 1;
    if (k === 'joker') s = JUNK_JOKER.test(o.name || '') ? 0 : 10 + jokerTier(o.name) * 10;
    else if (k === 'planet' || PLANET_NAMES.has(o.name)) {
      const f = planetFam(o) || FAM_BY_PLANET[o.name];
      s = f === needFam ? 30 : 5;
    }
    if (s > bs) { bs = s; best = o; }
  }
  return best;
}
