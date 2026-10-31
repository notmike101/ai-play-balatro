/* eslint-disable @stylistic/max-statements-per-line -- compact switch-case rows mirror the original tmp/dbimport one-liners */
/* tools/dbimport.mjs — INCREMENTAL SQLite mirror of out/log.jsonl (jsonl stays canonical).
   Reads only bytes appended since the stored offset (meta.last_off) — ~100ms steady-state,
   so analysis can run on EVERY wake instead of waiting for batched evidence windows.
   Also stamps deploy rows from git log (cohort epochs without manual bookkeeping).
   Derived data: safe to delete the db and rerun for a full rebuild. */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const DIR = path.dirname(path.dirname(fs.realpathSync(process.argv[1])));
const LOG = path.join(DIR, 'out', 'log.jsonl');
const DB = path.join(DIR, 'out', 'runs.db');

const db = new DatabaseSync(DB);
db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS deploy(sha TEXT PRIMARY KEY, ts INT, imported_ts INT);
CREATE TABLE IF NOT EXISTS decide(ts INT,rid INT,a TEXT,fam TEXT,pred INT,rem INT,ante INT,stk INT,b TEXT,tgt INT,rchips INT,err TEXT,ef TEXT,lk TEXT,enh INT,sla TEXT,cids TEXT,sids TEXT);
CREATE TABLE IF NOT EXISTS turn(ts INT,rid INT,chips INT,dl INT,hl INT,rerolls INT);
CREATE TABLE IF NOT EXISTS shopdump(ts INT,rid INT,pre INT,money INT,ante INT,nf TEXT,items TEXT);
CREATE TABLE IF NOT EXISTS shopdone(ts INT,rid INT,money INT,actions TEXT);
CREATE TABLE IF NOT EXISTS packdump(ts INT,rid INT,items TEXT);
CREATE TABLE IF NOT EXISTS gamefam(ts INT,rid INT,n TEXT,via TEXT,gamefam TEXT);
CREATE TABLE IF NOT EXISTS lvljump(ts INT,rid INT,ante INT,sig TEXT);
CREATE TABLE IF NOT EXISTS blind(ts INT,rid INT,ante INT,name TEXT,target INT,boss TEXT,jokers TEXT,cons TEXT,m INT);
CREATE TABLE IF NOT EXISTS handstab(ts INT,rid INT,ante INT,rows TEXT);
CREATE TABLE IF NOT EXISTS planet(ts INT,rid INT,fam TEXT,n TEXT,gf TEXT);
CREATE TABLE IF NOT EXISTS runstart(ts INT,rid INT,stake TEXT);
CREATE TABLE IF NOT EXISTS runend(ts INT,rid INT,won INT,ante INT);
CREATE TABLE IF NOT EXISTS rundigest(t INT,rid INT,won INT,ante INT,focal TEXT,focalPlays INT,focalLvl INT,lvlMap TEXT,lvlAct INT,uses INT,rerolls INT,celestial INT,jokers INT,alert TEXT,complete INT,gap INT);
CREATE TABLE IF NOT EXISTS jkpass(ts INT,rid INT,n TEXT,s REAL,cost INT,money INT,floor INT,ante INT,owned INT);
CREATE TABLE IF NOT EXISTS other(ts INT,rid INT,e TEXT,body TEXT);
CREATE INDEX IF NOT EXISTS ix_decide ON decide(rid,ts);
CREATE INDEX IF NOT EXISTS ix_turn ON turn(rid,ts);
CREATE INDEX IF NOT EXISTS ix_shopdump ON shopdump(rid,ts);
CREATE INDEX IF NOT EXISTS ix_other ON other(rid,ts,e);
CREATE INDEX IF NOT EXISTS ix_digest_t ON rundigest(t);
CREATE INDEX IF NOT EXISTS ix_shopdone_t ON shopdone(ts);
CREATE INDEX IF NOT EXISTS ix_blind_t ON blind(ts);
CREATE VIEW IF NOT EXISTS runmax AS SELECT rid, MAX(ante) m, MAX(CASE WHEN won=1 THEN 1 ELSE 0 END) w, MIN(t) t0 FROM rundigest GROUP BY rid;
`);
try { db.exec('ALTER TABLE rundigest ADD COLUMN gap INT'); } catch { /* present */ }

const getOff = () => Number(db.prepare('SELECT v FROM meta WHERE k=\'last_off\'').get()?.v ?? 0);
const setOff = (v) => db.prepare('INSERT INTO meta(k,v) VALUES(\'last_off\',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(String(v));

/* HEAD deploy stamp: one row per distinct commit, ts = commit time (cohort epoch) */
let head = '';
try { head = execSync(`git -C "${DIR}" rev-parse HEAD`, { encoding: 'utf8' }).trim(); } catch { /* not a repo */ }
if (head) {
    /* stamp the last 25 commits every import (one cheap git call, INSERT OR IGNORE)
       so cohort epochs exist for every policy change retroactively */
    const put = db.prepare('INSERT OR IGNORE INTO deploy(sha,ts,imported_ts) VALUES(?,?,?)');
    put.run(head, Date.now(), Date.now());
    let log = '';
    try { log = execSync('git log -25 "--format=%H %ct"', { encoding: 'utf8', cwd: DIR }); } catch { /* not a repo */ }
    for (const l of log.trim().split('\n').filter(Boolean)) {
        const [sha, ct] = l.split(' ');
        put.run(sha, 1000 * Number(ct), Date.now());
    }
}

let start = getOff();
const size = fs.statSync(LOG).size;
if (start > size) { start = 0; db.exec('DELETE FROM decide; DELETE FROM turn; DELETE FROM shopdump; DELETE FROM shopdone; DELETE FROM packdump; DELETE FROM gamefam; DELETE FROM lvljump; DELETE FROM blind; DELETE FROM handstab; DELETE FROM planet; DELETE FROM runstart; DELETE FROM runend; DELETE FROM rundigest; DELETE FROM jkpass; DELETE FROM other;'); }

const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const B = (v) => (v ? 1 : 0);
const Q = (k, cols) => db.prepare(`INSERT INTO ${k} (${cols}) VALUES (${Array.from({ length: cols.split(',').length }, () => '?').join(',')})`);
const ins = {
    decide: Q('decide', 'ts,rid,a,fam,pred,rem,ante,stk,b,tgt,rchips,err,ef,lk,enh,sla,cids,sids'),
    turn: Q('turn', 'ts,rid,chips,dl,hl,rerolls'),
    shopdump: Q('shopdump', 'ts,rid,pre,money,ante,nf,items'),
    shopdone: Q('shopdone', 'ts,rid,money,actions'),
    packdump: Q('packdump', 'ts,rid,items'),
    gamefam: Q('gamefam', 'ts,rid,n,via,gamefam'),
    lvljump: Q('lvljump', 'ts,rid,ante,sig'),
    blind: Q('blind', 'ts,rid,ante,name,target,boss,jokers,cons,m'),
    handstab: Q('handstab', 'ts,rid,ante,rows'),
    planet: Q('planet', 'ts,rid,fam,n,gf'),
    runstart: Q('runstart', 'ts,rid,stake'),
    runend: Q('runend', 'ts,rid,won,ante'),
    rundigest: Q('rundigest', 't,rid,won,ante,focal,focalPlays,focalLvl,lvlMap,lvlAct,uses,rerolls,celestial,jokers,alert,complete,gap'),
    jkpass: Q('jkpass', 'ts,rid,n,s,cost,money,floor,ante,owned'),
};
const insOther = Q('other', 'ts,rid,e,body');

let n = 0, bad = 0;
if (start < size) {
    const fd = fs.openSync(LOG, 'r');
    const CHUNK = 8 << 20;
    let off = start;
    db.exec('BEGIN');
    for (;;) {
        if (off >= size) break;
        const len = Math.min(CHUNK, size - off);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        let end = len;
        if (off + len < size) {
            end = buf.lastIndexOf(0x0a); /* newline byte = safe UTF-8 boundary */
            if (end === -1) { off += len; continue; } /* pathological >CHUNK line: skip */
        }
        off += end === len ? len : end + 1;
        for (const s of buf.subarray(0, end).toString('utf8').split('\n')) {
            if (!s.trim()) continue;
            let j;
            try { j = JSON.parse(s); } catch { bad++; continue; }
            if (!j || !j.e) continue;
            n++;
            const ts = j.ts ?? null;
            const rid = j.rid ?? null;
            switch (j.e) {
                case 'decide': ins.decide.run(ts, rid, j.a ?? '', j.fam ?? '', j.pred ?? null, j.rem ?? null, j.ante ?? null, j.stk ?? null, j.b ?? '', j.tgt ?? null, j.rchips ?? null, j.err ?? '', j.ef ?? '', j.lk ?? '', j.enh ?? null, j.sla ?? '', j.cids ?? '', j.sids ?? ''); break;
                case 'turn': ins.turn.run(ts, rid, j.chips ?? null, j.dl ?? null, j.hl ?? null, j.rerolls ?? null); break;
                case 'shopdump': ins.shopdump.run(ts, rid, j.pre ? 1 : 0, j.money ?? null, j.ante ?? null, j.nf ?? null, J(j.items)); break;
                case 'shopdone': ins.shopdone.run(ts, rid, j.money ?? null, J(j.actions)); break;
                case 'packdump': ins.packdump.run(ts, rid, J(j.items)); break;
                case 'gamefam': ins.gamefam.run(ts, rid, j.n ?? '', j.via ?? '', j.gamefam ?? ''); break;
                case 'lvljump': ins.lvljump.run(ts, rid, j.ante ?? null, j.sig ?? ''); break;
                case 'blind': ins.blind.run(ts, rid, j.ante ?? null, j.name ?? '', j.target ?? null, J(j.boss), J(j.jokers), J(j.cons), j.m ?? null); break;
                case 'handstab': ins.handstab.run(ts, rid, j.ante ?? null, J(j.rows)); break;
                case 'planet': ins.planet.run(ts, rid, j.fam ?? '', j.n ?? '', J(j.gamefam ?? null)); break;
                case 'runstart': ins.runstart.run(ts, rid, j.stake ?? ''); break;
                case 'runend': ins.runend.run(ts, rid, B(j.won), j.ante ?? null); break;
                case 'rundigest': ins.rundigest.run(j.t ?? ts, rid, B(j.won), j.ante ?? null, j.focal ?? '', j.focalPlays ?? null, j.focalLvl ?? null, j.lvlMap ?? '', j.lvlAct ?? null, j.uses ?? null, j.rerolls ?? null, B(j.celestial), j.jokers ?? null, j.alert ?? '', B(j.complete), j.gap ?? null); break;
                case 'jkpass': ins.jkpass.run(ts, rid, j.n ?? '', j.s ?? null, j.cost ?? null, j.money ?? null, j.floor ?? null, j.ante ?? null, j.ownedJ ?? null); break;
                default: insOther.run(ts, rid, j.e, s.slice(0, 2000)); break;
            }
        }
    }
    db.exec('COMMIT');
    fs.closeSync(fd);
    setOff(off);
}
console.log('new rows:', n, 'unparseable:', bad, '| offset:', getOff(), '/', size);
