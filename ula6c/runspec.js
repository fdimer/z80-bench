// ---- Runs the closed-loop Spectrum (ula6c/specula.js) for a few frames and checks its picture ----
//   SPEC_ROM=/path/to/48.rom node ula6c/runspec.js [frames] [boot|cold]
// boot (the default): the emulator (src/spectrum.js) runs the ROM's start-up, then the gate-level machine takes over
// its RAM and registers. cold: the gate-level machine starts from power-on (the ROM's RAM test takes a few seconds
// of Spectrum time). Each frame the ULA puts out is checked against the screen in its own lower RAM.
const fs = require('fs'), vm = require('vm'), path = require('path');
const romPath = process.env.SPEC_ROM; if (!romPath) { console.log('set SPEC_ROM to a Spectrum 48K ROM image'); process.exit(1); }
const FRAMES = +(process.argv[2] || 3), MODE = process.argv[3] || 'boot';
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'memchips.js', 'spectrum.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.SpecMachine = SpecMachine; this.Z80 = Z80;', ctx);
const { SpecUla } = require('./specula.js'), { Ula6cFast } = require('./fastsim.js'), { pictureCheck } = require('./piccheck.js');
const rom = new Uint8Array(fs.readFileSync(romPath));
const u = new Ula6cFast(fs.readFileSync(path.join(__dirname, '6c001.net'), 'utf8'));
const s = new SpecUla(ctx.Z80, u, rom);
if (MODE === 'boot') {
  const m = new ctx.SpecMachine(); m.loadRom(rom); m.reset(); m.run(3.5e6 * 2.5);
  for (let i = 0; i < 0x300; i++) m.poke(0x5800 + i, (i * 37 + (i >> 5)) & 0x7F);        // a coloured screen (no flash)
  for (let i = 0; i < 0x1000; i++) m.poke(0x4000 + i, [0x00, 0xFF, 0xAA, 0x55, 0xF0, 0x0F, 0x81, 0x3C][(i >> 5) & 7]);
  s.adopt(m);
}
let checks = [];
s.onFrame = (fr) => checks.push(Object.assign({ frame: s.frames, pc: s.cpu.pc.toString(16) }, pictureCheck(fr, s.W, s.H, s.ram)));
const t0 = Date.now(); const f0 = s.frames;
while (s.frames < f0 + FRAMES) s.step();
const wall = (Date.now() - t0) / 1000;
for (const c of checks) console.log(`frame ${c.frame}: PC ${c.pc}; picture ${c.found ? `at dot ${c.x0}, line ${c.y0}: ${c.bad} of ${c.n} dots differ` : 'not found'}; border colour ${c.border}`);
console.log(`${FRAMES} frames in ${wall.toFixed(1)} s (${(FRAMES * 0.019968 / wall * 100).toFixed(1)}% of a real Spectrum); ${s.cycles} bus cycles, ${s.holds} T-states held, ${s.ints} interrupts, ${u.events} gate events`);
