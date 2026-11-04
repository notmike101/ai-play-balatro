/* extract_jokers.mjs — game-truth joker table from the poker.gl.ax IndexedDB
   blobs (skill balatro-clone-game-truth-extraction): blob 20 = configs
   (rarity/cost/config-values), blob 23 = ENGLISH text (multi-line arrays).
   Emits out/joker_truth.json = [{key,name,rarity,cost,cfg,text}]. Read-only
   against the blobs; rerunnable when the game updates. */
import fs from 'node:fs';

const DIR = 'D:/balatro-ai/chrome-profile/Default/IndexedDB/https_poker.gl.ax_0.indexeddb.blob/1/00/';

const cfgRaw = fs.readFileSync(`${DIR}20`, 'latin1');
const txtRaw = fs.readFileSync(`${DIR}23`, 'latin1');

/**
 * strip {C:...} color tags from a loc line.
 *
 * @param {string} s - raw text
 * @returns {string} clean text
 */
function stripTags(s) {
    return s.replaceAll(/{[^{}]*}/g, '').replaceAll(/\s+/g, ' ').trim();
}

const texts = new Map();
const KEY_RE = '(?:j_|c_|s_)[a-z0-9_]+';

for (const m of txtRaw.matchAll(new RegExp(`(${KEY_RE})\\s*=\\s*\\{\\s*\\r?\\n\\s*name="([^"]*)",\\s*\\r?\\n\\s*text=\\{([^]*?)\\},`, 'g'))) {
    const lines = m[3].split(/",\s*\r?\n\s*"/).map((x) => stripTags(x.replaceAll(/^"|"[),]?$/g, ''))).filter(Boolean);

    if (!texts.has(m[1])) {
        texts.set(m[1], { name: m[2], text: lines.join(' ') });
    }
}

const out = [];
const seen = new Set();

for (const m of cfgRaw.matchAll(/(j_[\d_a-z]+)\s*=\s*{([^]*?)config\s*=\s*{([^}]*)}/g)) {
    const key = m[1];

    if (seen.has(key)) {
        continue;
    }

    seen.add(key);
    const pre = m[2];
    const name = (pre.match(/name\s*=\s*"([^"]+)"/) || [])[1] || (texts.get(key) || {}).name || key;
    const rarity = Number((pre.match(/rarity\s*=\s*(\d)/) || [0, 1])[1]);
    const cost = Number((pre.match(/cost\s*=\s*(\d+)/) || [0, 0])[1]);

    out.push({ key, name, rarity, cost, cfg: m[3].replaceAll(/\s+/g, ' ').trim(), text: (texts.get(key) || {}).text || '' });
}

out.sort((a, b) => a.rarity - b.rarity || a.name.localeCompare(b.name));

/* tarot table: blob20 c_* configs carry set="Tarot" + effect + config values
   (same no-space key form - regex allows both), text from blob23 c_* defs. */
const tarots = [];
const spectrals = [];
const tseen = new Set();

for (const m of cfgRaw.matchAll(/(c_[\d_a-z]+)\s*=\s*{([^]*?)config\s*=\s*{([^}]*)}/g)) {
    const key = m[1];

    if (tseen.has(key)) {
        continue;
    }

    tseen.add(key);
    const spec = /set\s*=\s*"Spectral"/.test(m[2]);

    if (!/set\s*=\s*"Tarot"/.test(m[2]) && !spec) {
        continue;
    }

    (spec ? spectrals : tarots).push({
        key,
        name: (m[2].match(/name\s*=\s*"([^"]+)"/) || [])[1] || (texts.get(key) || {}).name || key,
        effect: (m[2].match(/effect\s*=\s*"([^"]*)"/) || [])[1] || '',
        cost: Number((m[2].match(/cost\s*=\s*(\d+)/) || [0, 0])[1]),
        cfg: m[3].replaceAll(/\s+/g, ' ').trim(),
        text: (texts.get(key) || {}).text || '',
    });
}

tarots.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync('out/joker_truth.json', JSON.stringify({ jokers: out, tarots, spectrals }, null, 1));

const mystic = out.find((x) => x.key === 'j_mystic_summit');

if (!mystic || !mystic.text.includes('discards') || !mystic.cfg.includes('mult = 15')) {
    console.error('SANITY FAIL mystic:', JSON.stringify(mystic));
    process.exit(1);
}

const noText = out.filter((x) => !x.text).map((x) => x.key);

console.log('jokers:', out.length, '| named:', out.filter((x) => x.name !== x.key).length, '| texted:', out.filter((x) => x.text).length, '| no-text:', noText.join(',') || '-');
console.log('tarots:', tarots.length, '| texted:', tarots.filter((x) => x.text).length, '| names:', tarots.map((x) => x.name).join(', '));
console.log('spectrals:', spectrals.length, '| texted:', spectrals.filter((x) => x.text).length, '| names:', spectrals.map((x) => x.name).join(', '));
