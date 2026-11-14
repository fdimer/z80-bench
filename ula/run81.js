// ---- Run the closed-loop ZX81 (ula/zx81ula.js) from the command line ----
//   ZX81_ROM=/path/to/rom [KEYS="0.9:1 1.1:P"] [PGM=picture.pgm] node ula/run81.js [seconds] [engine: sync | net]
// Boots the ROM on the gate-level or the synchronous ULA and prints the picture as text, with how fast it ran.
const fs = require('fs'), path = require('path');
const { Z80 } = require('../src/z80core.js'), { UlaSim } = require('./sim.js'), { SyncUla } = require('./v2js.js'), { Zx81Ula } = require('./zx81ula.js');
const romPath = process.env.ZX81_ROM; if (!romPath) { console.log('set ZX81_ROM to the ZX81 ROM image'); process.exit(1); }
const secs = +(process.argv[2] || 1), which = process.argv[3] || 'sync';
const engine = which === 'net' ? new UlaSim(fs.readFileSync(path.join(__dirname, '2c210.net'), 'utf8'), { init: { NMION: 0, NMIOFF: 1, 'FRAME-SYNC': 0, FSL: 1 } })
  : new SyncUla(fs.readFileSync(path.join(__dirname, '2c210_sync.v'), 'utf8'));
const m = new Zx81Ula(Z80, engine, new Uint8Array(fs.readFileSync(romPath)), { ramSize: +(process.env.RAM || 0x4000) });
// KEYS="0.9:1 1.1:P": hold each key for 0.1 s from the given time (seconds of ZX81 time)
const keys = (process.env.KEYS || '').split(' ').filter(Boolean).map(k => { const [at, name] = k.split(':'); return { at: +at * 3.25e6, name }; });
const t0 = Date.now(), T0 = m.T, end = T0 + Math.round(secs * 3.25e6);
while (m.T < end) { for (const k of keys) m.key(k.name, m.T - T0 >= k.at && m.T - T0 < k.at + 325000); m.run(2000); }
const wall = (Date.now() - t0) / 1000;
if (process.env.PGM) fs.writeFileSync(process.env.PGM, Buffer.concat([Buffer.from(`P5\n${m.W} ${m.H}\n255\n`), Buffer.from(m.frame.map(v => v === 1 ? 0 : v === 2 ? 255 : 128))]));
console.log(`${which}: ${secs} s of ZX81 time in ${wall.toFixed(1)} s (${(wall / secs).toFixed(0)} times slower than a ZX81); frames ${m.frames}, NMIs ${m.nmis}, interrupts ${m.ints}, wait states ${m.waits}, PC ${m.cpu.pc.toString(16)}`);
if (!process.env.PGM) {
// the picture: one character per 2x2 dots... keep it small: every 4th line, every 2nd dot
const f = m.frame; let rows = [];
for (let y = 0; y < m.H; y += 4) { let s = ''; for (let x = 0; x < m.W; x += 2) s += f[y * m.W + x] === 1 ? '#' : f[y * m.W + x] === 2 ? '.' : ' '; rows.push(s.replace(/\s+$/, '')); }
while (rows.length && !rows[rows.length - 1]) rows.pop(); console.log(rows.join('\n'));
}
