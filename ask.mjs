// ask.mjs — one-shot request: node ask.mjs '<json args>' [--act] ; prints parsed response
import { spawn } from 'node:child_process';
const req = JSON.parse(process.argv[2]);
req.v = 1; req.id = req.id || ('q' + Date.now().toString(36));
const p = spawn(process.execPath, ['automation-host.mjs', '--origin', 'https://poker.gl.ax'], { cwd: import.meta.dirname });
let buf = '';
const to = setTimeout(() => { console.error('LOCAL_TIMEOUT'); p.kill(); process.exit(2); }, req.op === 'act' ? 90000 : 40000);
p.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line || !line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.id === req.id) { clearTimeout(to); console.log(JSON.stringify(j)); p.kill(); process.exit(j.ok ? 0 : 1); }
    else if (j.event) console.error('evt:', j.event);
    else if (j.id) console.error('other:', line.slice(0, 300));
  }
});
p.stderr.on('data', d => console.error('E:', d.toString().slice(0, 300)));
p.stdin.write(JSON.stringify(req) + '\n');
