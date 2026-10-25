// settings.mjs — one-shot game settings passes (currently: crank game speed to max).
import { act } from './link.mjs';
import { OUT, say, jw, tryLoad0 } from './knowledge.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Returns true if the settings pass ran (caller should re-observe), false if nothing to do.
export async function setGameSpeed(obs) {
  const sCtl = (obs.controls || []).find(c => c.enabled && c.kind === 'settings')
    || (obs.controls || []).find(c => c.enabled && c.kind === 'options');
  if (!sCtl) return false;
  const r = await act({ epoch: obs.epoch, action: 'activate', target: sCtl.id });
  if (!r.ok) return false;
  let o = r.result; let changed = false;
  fs.writeFileSync(path.join(OUT, 'options.json'), JSON.stringify(o));
  const s2 = (o.controls || []).find(c => c.enabled && c.kind === 'settings');
  if (s2) { const r2 = await act({ epoch: o.epoch, action: 'activate', target: s2.id }); if (r2.ok) o = r2.result; }
  for (let i = 0; i < 8; i++) {
    const cands = (o.controls || []).filter(c => c.enabled && c.kind === 'option_cycle' && Array.isArray(c.options));
    const isNum = a => a.length >= 3 && a.every(s => /^\d+(\.\d+)?$/.test(String(s))); // speed cycle: ["0.5","1","2","4"]
    const sp = cands.find(c => /speed/i.test(String(c.label || '')) && isNum(c.options)) || cands.find(c => isNum(c.options));
    if (!sp) break;
    const fresh = o.controls.find(c => c.id === sp.id) ?? sp;
    if (fresh.index >= fresh.options.length) break; // adapter cycle indices are 1-based: last == options.length
    const up = cands.find(c => c.id !== sp.id && c.options.length === sp.options.length && c.options[0] === sp.options[0] && (c.label === '>' || c.direction === 'r')) || (sp.label === '>' || sp.direction === 'r' ? sp : null);
    if (!up) break;
    const rr = await act({ epoch: o.epoch, action: 'activate', target: up.id });
    if (!rr.ok) break;
    o = rr.result; changed = true;
  }
  fs.writeFileSync(path.join(OUT, 'options.json'), JSON.stringify(o));
  for (let c2 = 0; c2 < 3; c2++) {
    const cl = (o.controls || []).find(c => c.enabled && /close|back|resume|done/i.test(c.kind + ' ' + (c.label || '')));
    if (!cl) break;
    const rc = await act({ epoch: o.epoch, action: 'activate', target: cl.id });
    if (!rc.ok) break; o = rc.result;
    if (!['overlay', 'options'].includes(o.phase || '')) break;
  }
  const p2 = tryLoad0('policy.json', {}); p2.speedSet = true; fs.writeFileSync(path.join(OUT, 'policy.json'), JSON.stringify(p2));
  say('speed set attempted, changed =', changed); jw({ e: 'speed', changed });
  return true;
}
