// ---- Run the closed-loop ZX81 (ula/zx81ula.js) from the command line ----
//   ZX81_ROM=/path/to/rom [KEYS="0.9:1 1.1:P"] [PGM=picture.pgm] [P=program.p] node ula/run81.js [seconds] [engine: fast | yosys | sync | net]
// Boots the ROM on the gate-level or the synchronous ULA and prints the picture as text, with how fast it ran.
const fs = require('fs'), path = require('path');
const { Z80 } = require('../src/z80core.js'), { UlaSim } = require('./sim.js'), { SyncUla } = require('./v2js.js'), { Zx81Ula } = require('./zx81ula.js');
const romPath = process.env.ZX81_ROM; if (!romPath) { console.log('set ZX81_ROM to the ZX81 ROM image'); process.exit(1); }
const secs = +(process.argv[2] || 1), which = process.argv[3] || 'fast';
const V = require('./v2js.js'), { Zx81Fast } = require('./zx81fast.js');
const syncText = fs.readFileSync(path.join(__dirname, '2c210_sync.v'), 'utf8'), romImg = new Uint8Array(fs.readFileSync(romPath)), opts = { ramSize: +(process.env.RAM || 0x4000) };
// engines: fast (default) = the synchronous design, clock edge by clock edge; yosys = the same after Yosys (YOSYS_JSON);
// sync and net = the general harness (zx81ula.js) on the synchronous design and on the netlist
const m = which === 'fast' ? new Zx81Fast(Z80, V.translate(syncText, 'ula2c210_core'), romImg, opts)
  : which === 'yosys' ? new Zx81Fast(Z80, V.fromYosys(JSON.parse(fs.readFileSync(process.env.YOSYS_JSON, 'utf8')), 'ula2c210_core'), romImg, opts)
  : new Zx81Ula(Z80, which === 'net' ? new UlaSim(fs.readFileSync(path.join(__dirname, '2c210.net'), 'utf8'), { init: { NMION: 0, NMIOFF: 1, 'FRAME-SYNC': 0, FSL: 1 } }) : new SyncUla(syncText), romImg, opts);
if (process.env.P) m.tape = new Uint8Array(fs.readFileSync(process.env.P));      // P=file.p: the tape for LOAD "" (fast and yosys engines)
// KEYS="2.6:J 2.9:Shift:0.25 2.95:P": hold each key from the given time for 0.1 s, or for the third figure (seconds of ZX81 time)
const keys = (process.env.KEYS || '').split(' ').filter(Boolean).map(k => { const [at, name, dur] = k.split(':'); return { at: +at * 3.25e6, name, dur: +(dur || 0.1) * 3.25e6 }; });
const t0 = Date.now(), T0 = m.T, end = T0 + Math.round(secs * 3.25e6);
while (m.T < end) { for (const n of new Set(keys.map(k => k.name))) m.key(n, keys.some(k => k.name === n && m.T - T0 >= k.at && m.T - T0 < k.at + k.dur)); if (0) for (const k of keys) m.key(k.name, m.T - T0 >= k.at && m.T - T0 < k.at + k.dur); m.run(2000); }
const wall = (Date.now() - t0) / 1000;
if (process.env.PGM) fs.writeFileSync(process.env.PGM, Buffer.concat([Buffer.from(`P5\n${m.W} ${m.H}\n255\n`), Buffer.from(m.frame.map(v => v === 1 ? 0 : v === 2 ? 255 : 128))]));
console.log(`${which}: ${secs} s of ZX81 time in ${wall.toFixed(1)} s (${(wall / secs).toFixed(0)} times slower than a ZX81); frames ${m.frames}, NMIs ${m.nmis}, interrupts ${m.ints}, wait states ${m.waits}, PC ${m.cpu.pc.toString(16)}`);
if (process.env.TEXT) {       // the display file as text, read from RAM (to compare with another emulator; not what the ULA drew)
  const CH = ' ??????????"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', r = a => m.ram[a - 0x4000]; let p = (r(0x400C) | r(0x400D) << 8) + 1, out = [];
  for (let row = 0; row < 24; row++) { let s = ''; for (let i = 0; i < 33; i++) { const v = r(p++); if (v === 0x76) break; s += v & 0x80 ? CH[v & 0x3F].toLowerCase() : CH[v & 0x3F]; } out.push(s.replace(/\s+$/, '')); }
  console.log(out.filter(x => x).join('\n'));
} else if (!process.env.PGM) {
// the picture: one character per 2x2 dots... keep it small: every 4th line, every 2nd dot
const f = m.frame; let rows = [];
for (let y = 0; y < m.H; y += 4) { let s = ''; for (let x = 0; x < m.W; x += 2) s += f[y * m.W + x] === 1 ? '#' : f[y * m.W + x] === 2 ? '.' : ' '; rows.push(s.replace(/\s+$/, '')); }
while (rows.length && !rows[rows.length - 1]) rows.pop(); console.log(rows.join('\n'));
}
