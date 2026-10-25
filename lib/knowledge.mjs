// knowledge.mjs — persistent state, logging, strategy knobs, joker/joker-factor knowledge.
import fs from 'node:fs';
import path from 'node:path';

export const DIR = path.join(import.meta.dirname, '..'); // poker-agent/ (automation-host.mjs lives here)
export const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });

const logF = fs.createWriteStream(path.join(OUT, 'log.jsonl'), { flags: 'a' });
export const resF = fs.createWriteStream(path.join(OUT, 'results.jsonl'), { flags: 'a' });
export const jw = o => logF.write(JSON.stringify(o) + '\n');
export const say = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function tryLoad0(p, d) { try { return JSON.parse(fs.readFileSync(path.join(OUT, p), 'utf8')); } catch { return d; } }
export const stakeMap = tryLoad0('stake_map.json', {}); // label<->number
export const wins = new Set(Object.keys(tryLoad0('wins.json', {}))); // labels won THIS session
export function saveWins() { fs.writeFileSync(path.join(OUT, 'wins.json'), JSON.stringify([...wins])); }
export function saveStakeMap() { fs.writeFileSync(path.join(OUT, 'stake_map.json'), JSON.stringify(stakeMap)); }
export const STAKE_LABELS = ['White Stake', 'Red Stake', 'Green Stake', 'Black Stake', 'Blue Stake', 'Purple Stake', 'Orange Stake', 'Gold Stake'];

// strategy knobs (editable via policy.json without restart)
export function policy() { return tryLoad0('policy.json', {}); }
export function buildFamilies() {
  const p = policy();
  return p.families || ['Flush', 'Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'Straight', 'Four of a Kind', 'Straight Flush', 'High Card'];
}

export const jokerFactor = {}; // family -> observed/expected multiplier EMA (calibrated from real scores)

// actively harmful for our discard-heavy single-family grind: fewer hands / no discards / money traps
export const JUNK_JOKER = /Half Joker|Credit Card|Burglar|Fortune Teller|Business Card|Red Card|Droll Joker|Sly Joker|Wily Joker|Devious Joker|Crafty Joker|Square Joker|^The Joker$/i;
export const STRONG_JOKER = /Blueprint|Brainstorm|The Duo|The Trio|The Family|The House|The Mark|The Lumberjack|Obelisk|Majestic|Merry|Bull|Sock|Faceless|Even Steven|Mystic|Alt|Banner|Abstract|Mime|Hologram|Chicot|Canio|Triboulet|Yorick|Supernova|Constellation|Green Joker|Ice Cream|Vampire|Hit the Road|The Half|Buster|Smeared|Ramén|Fibonacci|Pareidolia|Séance|Vagabond|Mad|Popsicle|Ride the Bus|Runner|Ice|Diet Cola|Splash|Nebula|Ghost|Dad|Stuntman|Walkie|Cerb|Blue Joker|Gray Joker|Chad|Sesquipedal|Turtle Bean|Sixth Sense|Judgment|Spirit|Uncertainty|Invisible/i;
export function jokerTier(name) { if (!name) return 0; return STRONG_JOKER.test(name) ? 2 : 1; }
