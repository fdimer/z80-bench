// ---- ZX81 ULA testbench: the gate-level 2C210 against the emulator's behaviour model ----
//   ZX81_ROM=/path/to/zx81.rom node ula/tb.js [frames]
// The emulator (src/zx80.js, ZX81 mode, 16K) boots the real ROM. Then, instruction by instruction, its Z80's bus
// cycles are replayed as Z80 bus waveforms on the gate-level ULA (ula/sim.js), clocked by the ULA's own clock, and
// what the ULA does is checked against what the emulator assumed:
//   the NOP fed to the Z80 for a character, the font address on A0'-A8' in the refresh that follows, the ROM and
//   RAM selects, the NMIs (line sync), vertical sync, the row counter, and the pixels on the video output.
// The run is open loop: the emulator's Z80 decides the bus, so a difference shows up as a report line, not as a crash.
// The ROM is read from the path given; it is never copied into the repository.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { UlaSim } = require('./sim.js');
const romPath = process.env.ZX81_ROM; if (!romPath) { console.log('set ZX81_ROM to the ZX81 ROM image'); process.exit(1); }
const FRAMES = +(process.argv[2] || 3);
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'z80asm.js', 'memchips.js', 'zx80.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.ZX80 = ZX80; this.ZX = ZX;', ctx);
const rom = new Uint8Array(fs.readFileSync(romPath));
const m = new ctx.ZX80(rom, 'zx81'); m.ramSize = 0x4000; m.reset();

// boot, then put some normal and inverse characters on the screen (the ROM displays whatever the display file holds)
m.run(3.25e6 * 3);
const dfile = m.mread(0x400C, false, true) | m.mread(0x400D, false, true) << 8;
{ let p = dfile + 1; for (let row = 0; row < 24; row++) { for (let col = 0; ; col++) { const v = m.mread(p, false, true); if (v === 0x76) break; if (row < 22) m.write(p, (row * 7 + col) % 64 | (col & 4 ? 0x80 : 0)); p++; } p++; } }
m.run(3.25e6 * 0.1);

// ---- the gate-level ULA ----
// which ULA: the netlist (default), the generated gate-level Verilog read back (ULA=gates.v), or the synchronous
// Verilog run through ula/v2js.js (ULA=sync), or that Verilog as synthesized by Yosys (ULA=yosys)
const WHICH = process.env.ULA || 'net';
const INIT = { NMION: 0, NMIOFF: 1, 'FRAME-SYNC': 0, FSL: 1 };
const facade = (real, map) => ({ set: (n, v) => real.set(map(n), v), get: n => real.get(map(n)), runTo: t => real.runTo(t), get t() { return real.t; }, get events() { return real.events; },
  watch: new Proxy({}, { set(_, k, f) { real.watch[map(k)] = f; return true; } }) });
let sim;
if (WHICH === 'net') sim = new UlaSim(fs.readFileSync(path.join(__dirname, '2c210.net'), 'utf8'), { init: INIT });
else if (WHICH === 'gates.v') {
  const { fromVerilog, san } = require('./gen_verilog.js'), init = {}; for (const k in INIT) init[san(k)] = INIT[k];
  sim = facade(new UlaSim(fromVerilog(fs.readFileSync(path.join(__dirname, '2c210_gates.v'), 'utf8')), { init }), san);
} else if (WHICH === 'yosys') {     // the synchronous core as Yosys synthesized it: YOSYS_JSON=core.json (see ula/v2js.js)
  const V = require('./v2js.js'); sim = new V.SyncUla(V.fromYosys(JSON.parse(fs.readFileSync(process.env.YOSYS_JSON, 'utf8')), 'ula2c210_core'));
} else sim = new (require('./v2js.js').SyncUla)(fs.readFileSync(path.join(__dirname, '2c210_sync.v'), 'utf8'));
const OSC = 1000 / 6.5;                   // ns per oscillator period
let oscT = 0, osc = 0;
// Z80 timing (ns after the clock edge): address, MREQ/RD/IORQ/WR/M1, and memory access time
const D = { addr: 40, ctl: 30, acc: 150 };
const tbq = [];                            // testbench actions: {t, f}
const at = (t, f) => { tbq.push({ t, f }); tbq.sort((a, b) => a.t - b.t); };
const busA = a => { for (let n = 0; n < 16; n++) { const name = n < 9 ? `A${n}'` : n === 14 ? 'nA14' : n === 15 ? 'nA15' : null; if (name) sim.set(name, a >> n & 1); } cpuA = a; };
let cpuA = 0, rdLow = false, mreqLow = false;

// the board's memory, seen from the ULA's data pins: it drives the bus while MREQ and RD are low (or in a refresh
// the ULA has selected the ROM), after its access time
let memOn = null;
function memory() {
  const romSel = sim.get('ROM.N.CS') === 0, ramSel = sim.get('RAM.N.CS') === 0;
  if (!mreqLow || !(rdLow || romSel)) { drive(0xFF); return; }
  const lo = aBus();
  const a = (cpuA & 0xFE00) | lo;          // A0-A8 reach the ROM and RAM through the ULA side of the resistors
  const v = romSel ? m.rom[a & 0x1FFF] : ramSel && rdLow ? m.mread(0x4000 | a & 0x3FFF, false, true) : 0xFF;
  drive(v);
}
let dOut = 0xFF;
const drive = v => { dOut = v; for (let n = 0; n < 8; n++) sim.set('nD' + n, v >> n & 1); };
const onMem = () => at(sim.t + D.acc, memory);
for (const n of ['ROM.N.CS', 'RAM.N.CS']) sim.watch[n] = onMem;
const dBus = () => { let v = 0; for (let n = 0; n < 8; n++) v |= sim.get('nD' + n) << n; return v; };
const aBus = () => { let v = 0; for (let n = 0; n < 9; n++) v |= sim.get(`A${n}'`) << n; return v; };
const ctl = (name, v) => { sim.set(name, v); if (name === 'nMREQ') { mreqLow = !v; onMem(); } if (name === 'nRD') { rdLow = !v; onMem(); } };

// ---- the clock: the Z80's CLK is N.PHI through TR2 (an inverter); a T-state starts on CLK rising (N.PHI falling) ----
let r1 = null;                             // time of the first CLK rise; the clock is regular from there
sim.watch['N.PHI'] = (v, t) => { if (v === (process.env.PHASE ? 1 : 0) && r1 === null) r1 = t; };
const P2 = 2 * OSC, rise = k => r1 + (k - 1) * P2, fall = k => rise(k) + OSC, tToT = t => (t - r1) / P2 + 1;
function step(until) {                     // run the oscillator and the testbench queue to `until` ns
  for (;;) {
    const nextOsc = oscT + OSC / 2, nextTb = tbq.length ? tbq[0].t : Infinity;
    if (nextTb <= nextOsc && nextTb <= until) { sim.runTo(nextTb); tbq.shift().f(); continue; }
    if (nextOsc <= until) { sim.runTo(nextOsc); oscT = nextOsc; osc ^= 1; sim.set('OSC', osc); continue; }
    sim.runTo(until); return;
  }
}

// ---- report ----
const rep = { ins: 0, inBad: [], m1: 0, chars: 0, nopBad: [], faBad: [], selBad: [], nmiSim: [], nmiEmu: [], vsSim: [], vsEmu: [], rowBad: [], pix: [] };
sim.watch['N.NMI'] = (v, t) => { if (v === 0) rep.nmiSim.push(tToT(t) + emuOff); };
sim.watch['FRAME-SYNC'] = (v, t) => rep.vsSim.push([tToT(t) + emuOff, v]);
const syncFalls = [], outs = [];
sim.watch['SYNCn'] = (v, t) => { if (v === 0) syncFalls.push(tToT(t) + emuOff); };
const vidEdges = []; sim.watch['TV/TAPE'] = (v, t) => vidEdges.push([t, v]);
const hs = m.hsyncs.bind(m); m.hsyncs = function () { while (this.nextH <= this.t) { if (this.nmiGen) rep.nmiEmu.push(this.nextH); hs(); } hs(); };

// let the ULA's clock start, then line the emulator's T-states up with it
step(3000);
let emuOff = m.t - (Math.floor(tToT(sim.t)) + 2);   // emulator T = sim T + emuOff
const endT = m.t + Math.round(FRAMES * 3.25e6 / 50);
const CT = { M1: 4, MR: 3, MW: 3, IR: 4, IW: 4, IA: 6 };
const keyAt = m.t + 70000;
while (m.t < endT) {
  if (m.t > keyAt && m.t < keyAt + 40000) m.keys[2] |= 1; else m.keys[2] &= ~1;   // Q (row A10, column KB0)
  m.preStep(); m.syncInt();
  const vsBefore = m.vsync;
  const cyc = m.cpu.step();
  const raw = cyc.map(c => c.k === 'M1' ? m.mread(c.a, true, true) : c.d);
  const t0 = m.t; m.afterStep(cyc);
  if (m.vsync !== vsBefore) rep.vsEmu.push([m.t, m.vsync ? 1 : 0]);
  let tt = t0;
  for (let i = 0; i < cyc.length; i++) {
    const c = cyc[i], s = tt - emuOff, R = k => rise(s + k - 1), F = k => fall(s + k - 1);
    if (c.k === 'M1' || c.k === 'IA') {
      const w = c.k === 'IA' ? 2 : 0;    // an interrupt acknowledge has two wait states; IORQ instead of MREQ and RD
      at(R(1) + D.addr, () => { busA(c.a); sim.set('nM1', 0); sim.set('nHALT', c.halt ? 0 : 1); });
      if (w) at(F(3) + D.ctl, () => sim.set('nIORQ', 0)); else at(F(1) + D.ctl, () => { ctl('nMREQ', 0); ctl('nRD', 0); });
      at(R(3 + w) + D.ctl, () => { ctl('nMREQ', 1); ctl('nRD', 1); sim.set('nIORQ', 1); sim.set('nM1', 1); });
      at(R(3 + w) + D.addr, () => busA(c.rf));
      at(F(3 + w) + D.ctl, () => ctl('nMREQ', 0));
      at(F(4 + w) + D.ctl, () => ctl('nMREQ', 1));
      if (c.ch !== undefined && process.env.WAVE && rep.chars === +process.env.WAVE) {   // dump a waveform of one character fetch
        const names = ['N.PHI', 'Q19', 'nM1', 'nMREQ', 'nRD', 'nD6', 'CHAR', 'LCLKn', 'LCLK', 'Q17', 'D6L', 'M1', 'FORCE', 'nD0', 'DB5', 'DC3', 'S/L', 'AENa', 'AEN', "A3'", 'Q20', 'ROM.N.CS', 'Q8', 'TV/TAPE'];
        const t1 = R(1) - 50, rows = names.map(() => '');
        for (let x = t1; x < R(7); x += 10) { step(x); names.forEach((n, j) => { const v = sim.get(n); rows[j] += v === undefined ? '?' : v === 2 ? '^' : v ? '-' : '_'; }); }
        names.forEach((n, j) => console.log(n.padEnd(9), rows[j])); console.log('T1 starts at column 5; 10 ns per column, 30.8 columns per T-state');
      }
      if (c.k === 'M1') {                 // T3: the Z80 takes the byte on CLK rising
        step(R(3) - 1); rep.m1++;
        const seen = dBus();
        if (seen !== c.d) rep.nopBad.push({ t: tt, a: c.a.toString(16), raw: raw[i], emu: c.d, sim: seen });
      }
      if (c.ch !== undefined) {           // the emulator took this fetch as a character: check the refresh
        step(F(4) - 2); rep.chars++;
        const a = aBus(), rs = sim.get('ROM.N.CS');
        if (a !== (c.fa & 0x1FF) || rs !== 0) rep.faBad.push({ t: tt, ch: c.ch, emu: c.fa & 0x1FF, sim: a, romcs: rs });
        const row = sim.get('Q29') | sim.get('Q30') << 1 | (1 - sim.get('NQ31')) << 2;
        if (row !== (c.fa & 7)) rep.rowBad.push({ t: tt, emu: c.fa & 7, sim: row });
        rep.pix.push({ t: tt + 4, bits: c.ch & 0x80 ? ~m.rom[c.fa & 0x1FFF] & 0xFF : m.rom[c.fa & 0x1FFF] });
      }
    } else if (c.k === 'MR' || c.k === 'MW') {
      at(R(1) + D.addr, () => busA(c.a));
      at(F(1) + D.ctl, () => { ctl('nMREQ', 0); if (c.k === 'MR') ctl('nRD', 0); });
      if (c.k === 'MW') at(F(2) + D.ctl, () => sim.set('nWR', 0));
      at(F(3) + D.ctl, () => { ctl('nMREQ', 1); ctl('nRD', 1); sim.set('nWR', 1); });
      step(F(2));
      const rs = sim.get('ROM.N.CS'), ms = sim.get('RAM.N.CS'), a14 = c.a >> 14 & 1;
      if (rs !== a14 || ms !== 1 - a14) rep.selBad.push({ t: tt, k: c.k, a: c.a.toString(16), romcs: rs, ramcs: ms });
    } else if (c.k === 'IR' || c.k === 'IW') {
      outs.push([tt, c.k, c.a & 0xFF]);
      // the keyboard: a pressed key joins its row (an address line A8-A15, low) to its column (KB0-KB4)
      let kb = 0x1F; for (let r = 0; r < 8; r++) if (!(c.a & (0x100 << r))) kb &= ~m.keys[r] & 0x1F;
      at(R(1) + D.addr, () => { busA(c.a); for (let n = 0; n < 5; n++) sim.set('nKB' + n, kb >> n & 1); });
      at(R(2) + D.ctl, () => { sim.set('nIORQ', 0); if (c.k === 'IR') ctl('nRD', 0); else sim.set('nWR', 0); });
      at(F(4) + D.ctl, () => { sim.set('nIORQ', 1); ctl('nRD', 1); sim.set('nWR', 1); });
      if (c.k === 'IR') { step(R(4) - 1); const seen = dBus(); if (seen !== c.d) rep.inBad.push({ t: tt, port: c.a.toString(16), emu: c.d.toString(16), sim: seen.toString(16) }); else { rep.ins++; if ((c.d & 0x1F) !== 0x1F) rep.keyIns = (rep.keyIns || 0) + 1; } }
    }
    tt += CT[c.k] || c.n || 0;
  }
  step(rise(m.t - emuOff) - 1);
}
step(sim.t + 40 * OSC);

// the ULA starts in an arbitrary state: its row counter is only right after its first vertical sync, so only what
// follows that is compared
const warm = (rep.vsSim.find(x => x[1] === 0) || [Infinity])[0];
for (const k of ['inBad', 'nopBad', 'faBad', 'rowBad', 'selBad', 'pix']) rep[k] = rep[k].filter(x => x.t > warm);
rep.pix = rep.pix.filter(x => x.t < m.t - 8);       // the run stops on an instruction boundary: the last character's dots have no next cycle to follow
rep.chars = rep.pix.length;

// ---- pixels: sample the video output at each dot of each character the emulator drew; the offset that matches
// best is the ULA's delay from the emulator's T-state t0+4 to the first dot ----
function lvl(t) { let lo = 0, hi = vidEdges.length - 1, v = 2; while (lo <= hi) { const mid = (lo + hi) >> 1; if (vidEdges[mid][0] <= t) { v = vidEdges[mid][1]; lo = mid + 1; } else hi = mid - 1; } return v; }
let best = null;
for (let off = -16; off <= 32; off++) {           // in half dots
  let bad = 0, n = 0;
  for (const p of rep.pix) {
    const T0 = p.t - emuOff;
    for (let b = 0; b < 8; b++) { const t = rise(T0) + (off / 2 + b + 0.5) * OSC; const ink = (p.bits >> (7 - b)) & 1; const v = lvl(t); if (v === 0) continue; n++; if ((v === 1) !== !!ink) bad++; }
  }
  if (n && (!best || bad < best.bad)) best = { off, bad, n };
}

// ---- NMIs: the sim's against the emulator's (both in emulator T-states) ----
const nmiPairs = rep.nmiEmu.map(e => { let b = null; for (const s of rep.nmiSim) if (b === null || Math.abs(s - e) < Math.abs(b - e)) b = s; return b === null ? null : +(b - e).toFixed(2); });
const hist = a => { const h = {}; for (const x of a) h[x] = (h[x] || 0) + 1; return h; };

if (process.env.DIAG) { const fc = rep.pix.length ? rep.pix[0].t - 4 : 0; const fsEnd = rep.vsSim.filter(x => x[1] === 0).map(x => x[0]);
  console.log('ports', outs.map(o => [o[0], o[1], o[2].toString(16), syncFalls.filter(s => s > o[0]).length]).slice(0, 12));
  console.log('first char', fc, 'syncs between each frame-sync end and first char:', fsEnd.map(e => syncFalls.filter(s => s > e && s < fc).length)); }
if (process.env.DIAG && best) { for (const p of rep.pix) { const T0 = p.t - emuOff; let s = ''; for (let b = 0; b < 8; b++) { const v = lvl(rise(T0) + (best.off / 2 + b + 0.5) * OSC); const ink = (p.bits >> (7 - b)) & 1; s += v === 0 ? 's' : (v === 1) === !!ink ? '.' : 'X'; } if (s.includes('X')) console.log('dots', p.t, p.bits.toString(2).padStart(8, '0'), s); } }
console.log(`ran ${FRAMES} frames: ${rep.m1} opcode fetches, ${rep.chars} characters, ${sim.events} gate events`);
console.log(`port reads: ${rep.ins} agree (${rep.keyIns || 0} with a key down), ${rep.inBad.length} differ`, rep.inBad.slice(0, 3));
console.log(`NOP for characters: ${rep.nopBad.length} fetches where the Z80 would read something else`, rep.nopBad.slice(0, 3));
console.log(`font address and ROM select in the refresh: ${rep.faBad.length} differ`, rep.faBad.slice(0, 3));
console.log(`row counter: ${rep.rowBad.length} differ`, hist(rep.rowBad.map(r => r.emu + '->' + r.sim)));
console.log(`ROM/RAM select on reads and writes: ${rep.selBad.length} differ`, rep.selBad.slice(0, 3));
console.log(`NMIs: emulator ${rep.nmiEmu.length}, ULA ${rep.nmiSim.length}; ULA minus emulator, in T-states:`, hist(nmiPairs));
console.log(`vertical sync: emulator`, rep.vsEmu.slice(0, 6), 'ULA', rep.vsSim.slice(0, 6).map(([t, v]) => [Math.round(t), v]));
console.log(`pixels: best offset ${best && best.off / 2} dots after T-state t0+4, ${best && best.bad} of ${best && best.n} dots differ`);
