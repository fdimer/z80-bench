// ---- ZX Spectrum ULA testbench: the gate-level 6C001E-7 (ula6c/6c001.net) against the emulator (src/spectrum.js) ----
//   SPEC_ROM=/path/to/48.rom node ula6c/tb.js [frames]
// The emulator boots the real ROM, then runs a short test program (below) in the upper RAM. Instruction by instruction,
// its Z80's bus cycles are replayed as Z80 bus waveforms on the gate-level ULA (ula6c/sim.js). The Z80 side is driven
// by the ULA's own CPU clock (pin 32), so when the ULA holds the clock the replayed cycle waits too. The board around
// the ULA is modelled: the lower 16K of RAM (4116s, row and column on A0-A6, read and written with the ULA's RAS, CAS
// and DRAMWE), the keyboard matrix on KB0-KB4, the EAR/MIC pin, and the 470 ohm resistors that join the ULA's data
// pins to the CPU's. What the ULA does is checked against what the emulator assumed:
//   the clock holds (contention) on every bus cycle, the interrupt, the CPU's reads of the lower RAM through the
//   ULA's RAS/CAS, ROM select, port FE (keyboard, EAR), the floating bus, the ULA's own screen reads, and the picture
//   (border and screen colours from the ULA's colour lines, dot by dot, against the emulator's picture).
// The run is open loop on data: the emulator's Z80 decides what happens, so a difference shows up as a report line.
// The ROM is read from the path given; it is never copied into the repository.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { Ula6cSim } = require('./sim.js');
const romPath = process.env.SPEC_ROM; if (!romPath) { console.log('set SPEC_ROM to a Spectrum 48K ROM image'); process.exit(1); }
const FRAMES = +(process.env.TB_FRAMES || (require.main === module && process.argv[2]) || 2);
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'memchips.js', 'spectrum.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.SpecMachine = SpecMachine; this.SPEC = SPEC;', ctx);
const { SPEC } = ctx;
const m = new ctx.SpecMachine(); m.loadRom(new Uint8Array(fs.readFileSync(romPath))); m.reset();

// ---- boot, a test picture, and the test program ----
m.run(3.5e6 * 3);
for (let i = 0; i < 0x1800; i++) m.poke(0x4000 + i, [0x00, 0xFF, 0xAA, 0x55, 0xF0, 0x0F, 0x81, 0x3C][(i >> 5) & 7] ^ (i & 0x18));
for (let i = 0; i < 0x300; i++) m.poke(0x5800 + i, (i * 37 + (i >> 5)) & 0xFF);
// 8000  LD SP,FF00 / loop: EI / HALT / (wait about 16,600 T-states, into the picture:) LD D,5 / DJNZ $ / DEC D / JR NZ / 24 x (IN A,(FF) / NOP) /
//       LD A,(5000) / LD (5001),A / LD A,E / AND 7 / OUT (FE),A / INC E / IN A,(FE) / IN A,(FF) / CALL 6000 /
//       LD A,E / ADD A,3 / AND 7 / OR 18 / OUT (FE),A / IN A,(FE) / IN A,(FF) / JR loop
// 6000  LD HL,4000 / LD B,32 / LD A,(HL) / INC L / IN A,(FF) / DJNZ -6 / LD BC,7FFE / IN A,(C) / RET      (code in the lower RAM)
const prog = [0x31, 0x00, 0xFF, 0xFB, 0x76, 0x16, 0x05, 0x06, 0x00, 0x10, 0xFE, 0x15, 0x20, 0xFB, ...Array(24).fill([0xDB, 0xFF, 0x00]).flat(), 0x3A, 0x00, 0x50, 0x32, 0x01,
  0x50, 0x7B, 0xE6, 0x07, 0xD3, 0xFE, 0x1C, 0xDB, 0xFE, 0xDB, 0xFF, 0xCD, 0x00, 0x60, 0x7B, 0xC6, 0x03, 0xE6, 0x07, 0xF6, 0x18,
  0xD3, 0xFE, 0xDB, 0xFE, 0xDB, 0xFF, 0x18, 0x00];
prog[prog.length - 1] = (0x8003 - (0x8000 + prog.length)) & 0xFF;
prog.forEach((b, i) => m.poke(0x8000 + i, b));
[0x21, 0x00, 0x40, 0x06, 0x20, 0x7E, 0x2C, 0xDB, 0xFF, 0x10, 0xFA, 0x01, 0xFE, 0x7F, 0xED, 0x78, 0xC9].forEach((b, i) => m.poke(0x6000 + i, b));
m.cpu.pc = 0x8000;
while (m.cpu.pc !== 0x8004) m.step();                    // to the HALT: the replay starts in step with the frame

// ---- the gate-level ULA ----
// the engine: ula6c/sim.js, or the same simulation compiled for speed (ULA_ENGINE=fast, ula6c/fastsim.js)
const sim = process.env.ULA_ENGINE === 'fast' ? new (require('./fastsim.js').Ula6cFast)(fs.readFileSync(path.join(__dirname, '6c001.net'), 'utf8'))
  : new Ula6cSim(fs.readFileSync(path.join(__dirname, '6c001.net'), 'utf8'));
const OSC = 1000 / 14, P = 4 * OSC;                       // ns per oscillator period, per T-state
const D = { addr: +(process.env.TB_ADDR || 40), ctl: +(process.env.TB_CTL || 30), cac: +(process.env.TB_CAC || 100), off: +(process.env.TB_HOLD || 150) };
const PIN = { A14: 'PN36_A14', A15: 'PN37_A15', MREQ: 'PN38_NMREQ', RD: 'PN3_NRD', WR: 'PN2_NWR', IORQ: 'PN33_NIORQ',
  CLK: 'PN32_NBCPU', INT: 'PN12_NINT', RAS: 'PN35_NRAS', CAS: 'PN1_NCAS', WE: 'PN4_NDRAMWE', ROMCS: 'PN34_NROMCS', EAR: 'PN28_TAPELS' };
const AP = ['PN5_A0', 'PN6_A1', 'PN7_A2', 'PN8_A3', 'PN9_A4', 'PN10_A5', 'PN11_A6'];
const DP = ['PN18_D0', 'PN21_D1', 'PN22_D2', 'PN25_D3', 'PN27_D4', 'PN29_D5', 'PN30_D6', 'PN31_D7'];
const KP = ['PN19_KB0', 'PN20_KB1', 'PN23_KB2', 'PN24_KB3', 'PN26_KB4'];
for (const n of ['MREQ', 'RD', 'WR', 'IORQ']) sim.set(PIN[n], 1);
const ulaDrivesA = () => sim.drivesPin(AP[0]);
const pinsVal = (names) => names.reduce((v, n, i) => v | ((sim.get(n) ?? 1) & 1) << i, 0);

// the CPU's address: A14, A15 straight to the ULA; A0-A6 through IC3/IC4 and 330 ohms (the ULA's own drive wins);
// the keyboard joins a half-row (A8-A15, the one held low) to KB0-KB4
let cpuA = 0;
const keyCols = a => { let v = 0x1F; for (let r = 0; r < 8; r++) if (!(a & (0x100 << r))) v &= ~m.keys[r] & 0x1F; return v; };
function busA(a) {
  cpuA = a; sim.set(PIN.A14, a >> 14 & 1); sim.set(PIN.A15, a >> 15 & 1); if (typeof ulaIorq === 'function') ulaIorq();
  for (let n = 0; n < 7; n++) sim.set(AP[n], a >> n & 1);
  const k = keyCols(a); for (let n = 0; n < 5; n++) sim.set(KP[n], k >> n & 1);
}
// the ULA's data pins: the lower RAM's output while it drives, else the CPU's data (through 470 ohms) while it writes,
// else nothing (high)
let dramOut = null, cpuOut = null;
function dPins() { const v = dramOut ?? cpuOut ?? 0xFF; for (let n = 0; n < 8; n++) sim.set(DP[n], v >> n & 1); }
// the EAR/MIC pin (issue 3 and later): high while the ULA drives its EAR output (N.LS low); no tape
const tapecell = sim.els.find(e => e.type === 'tapecell');
const nLS = tapecell.ins[0];
const earPin = () => sim.set(PIN.EAR, sim.get(nLS) ? 0 : 1);
sim.watch[nLS] = () => earPin(); earPin();

// ---- the lower RAM: eight 4116s. Row on RAS falling, column on CAS falling (A0-A6: the ULA's when it drives them,
// else the CPU's A0-A6 then A7-A13 through the multiplexers); the data appears tCAC after CAS falls; after CAS rises
// it stays on the data lines for D.off (the RAM lets go within 40 ns, but the lines hold the charge until something
// drives them: this is what makes the floating bus), then reads FFh
// it rises; a write takes the data pins' value when WE and CAS are both low ----
const ram = m.ram.slice(0, 0x4000);                         // the lower RAM, as the ULA reads and writes it: its own copy (the emulator runs an instruction or two ahead)
let row = 0, rasLow = false, casLow = false, dseq = 0;
const fetches = [], cpuDram = [];
const rasLog = [];
sim.watch[PIN.RAS] = (v) => { rasLow = !v; if (!v) { row = ulaDrivesA() ? pinsVal(AP) : cpuA & 0x7F; if (process.env.TB_DBG && rasLog.length < 400) { const t = sim.t, r0 = row; const s = []; for (const d of [-20, -5, 5, 15, 30]) sim.at(t + d < t ? t : t + d, () => s.push(pinsVal(AP))); rasLog.push({ t, r0, s }); } } };
function dramWrite(off) { dramOut = null; dPins(); dseq++; const v = pinsVal(DP); ram[off] = v; cpuDram.push({ t: sim.t, off, w: v }); }
let casOff = 0, casUla = false;
sim.watch[PIN.CAS] = (v) => {
  casLow = !v; const my = ++dseq;
  if (!v) {
    if (!rasLow) return;
    casUla = ulaDrivesA();
    const col = casUla ? pinsVal(AP) : cpuA >> 7 & 0x7F; casOff = row | col << 7;
    if (sim.get(PIN.WE) === 0) { dramWrite(casOff); return; }
    if (casUla) fetches.push({ t: sim.t, off: casOff });
    sim.at(sim.t + D.cac, () => { if (dseq === my && casLow) { dramOut = ram[casOff]; dPins(); } });
  } else sim.at(sim.t + D.off, () => { if (dseq === my) { dramOut = null; dPins(); } });
};
sim.watch[PIN.WE] = (v) => { if (v === 0 && casLow && rasLow) dramWrite(casOff); };

// ---- what the CPU sees on its data bus ----
const cpuRead = (a) => a < 0x4000 ? (sim.get(PIN.ROMCS) === 0 ? m.rom[a] : 0xFF) : a < 0x8000 ? pinsVal(DP) : m.ram[a - 0x4000];

// ---- the clock and the frame. The Z80's CLK is the inverse of pin 32 ----
let rI = null, intFall = null;
const ints = [];
sim.watch[PIN.INT] = (v, t) => { ints.push([t, v]); if (v === 0) intFall = t; };
let lastRise = null;
const hwT = t => (t - rI) / P;                              // T-states since the reference frame start
let osc = 0, oscT = 0;
function stepTo(t) { while (oscT + OSC / 2 <= t) { oscT += OSC / 2; sim.runTo(oscT); osc ^= 1; sim.set('PN39_OSC', osc); } sim.runTo(t); }
// free run to the first INT, then on to the emulator's frame position
let firstRise = null;
sim.watch[PIN.CLK] = (v, t) => { if (v === 0 && intFall !== null && firstRise === null) firstRise = t; };
while (firstRise === null && sim.t < 25e6) stepTo(sim.t + 1000);
if (firstRise === null) { console.log('no INT from the ULA'); process.exit(1); }
// T-state 0 of the frame, placed where the clock holds (contention) line up with the emulator's, which are Fuse's:
// the second CPU clock rise after INT falls. See the report's INT line for what that says about INT.
rI = firstRise + 2 * P;
let startT = rI + m.ft * P;                                  // the rise that starts the emulator's next instruction
if (startT < sim.t + P) { startT += SPEC.FRAME_T * P; rI += SPEC.FRAME_T * P; }
stepTo(startT - P / 2);

// ---- the Z80 bus, driven by the ULA's clock ----
const CL = { M1: 4, MR: 3, MW: 3, IR: 4, IW: 4, IA: 6 };
const Q = []; let cur = null, Tk = 0, lastA = 0, instr = 0, emuBase = m.ft;   // emuBase: emulator frame T of the instruction
const rep = { cyc: 0, holdBad: [], dataBad: [], romcsBad: [], ioBad: [], floatBad: [], floatN: 0, feN: 0, lowN: 0, frames: 0 };
let off0 = null;                                            // hw T minus emulator T, at the first cycle
function feed() {
  m.preStep(); m.syncInt();
  const ft0 = m.ft, pc = m.cpu.pc, cyc = m.cpu.step(); m.afterStep(cyc);
  const base = emuBase; instr++;
  for (const c of cyc) Q.push(Object.assign({}, c, { len: CL[c.k] || c.n, emuT: base + c.t0, emuW: c.w, pc }));
  emuBase += m.ft - ft0 + (m.ft < ft0 ? SPEC.FRAME_T : 0);
}
// TR6 on the board (issue 3 onwards; Timex's issue 6A diagram): an emitter follower from the CPU's A0 that holds the
// ULA's IORQ input high while A0 is high; through R27 (470 ohms) the ULA otherwise sees the CPU's IORQ. So the ULA
// sees an I/O request only for even ports.
let iorqN = 1;
const ulaIorq = () => sim.set(PIN.IORQ, iorqN | (cpuA & 1));
const ctl = (n, v, dt = D.ctl) => sim.at(sim.t + dt, () => { if (n === 'IORQ') { iorqN = v; ulaIorq(); } else sim.set(PIN[n], v); });
function edge(rise, t) {
  if (rise) {
    if (!cur || Tk >= cur.len) {
      while (Q.length < 2) feed();
      if (cur && (cur.k === 'M1' || cur.k === 'MR' || cur.k === 'MW')) {   // the hold the cycle just ended had, by the emulator's phase
        const hold = +(hwT(t) - cur.hwT - cur.len).toFixed(2), ef = Math.round(cur.emuT) % SPEC.FRAME_T, er = ef - 14335;
        if (er >= 0 && er < 192 * 224 && er % 224 < 128 && (cur.a & 0xC000) === 0x4000) { const key = `phase ${er & 7}: emulator ${cur.emuW}, ULA ${hold}`; (rep.ph2 = rep.ph2 || {})[key] = (rep.ph2[key] || 0) + 1; }
      }
      cur = Q.shift(); Tk = 1; cur.hwT = hwT(t);
      if (off0 === null) off0 = cur.hwT - cur.emuT;
      const d = cur.hwT - cur.emuT - off0;                   // drift: the ULA held the clock more or less than the emulator
      if (Math.abs(d - (rep.drift || 0)) > 0.25) { rep.holdBad.push({ k: prevK, pc: prevPc.toString(16), a: prevA.toString(16), emuT: Math.round(cur.emuT) % SPEC.FRAME_T, extra: +(d - (rep.drift || 0)).toFixed(2) }); }
      if (process.env.TB_WAVE) { const w0 = +process.env.TB_WAVE; if (!waveOn && cur.emuT >= w0 - 2 && cur.emuT < w0 + 14) { waveOn = true; waveDrift = d; } else if (waveOn && cur.emuT > w0 + 14) { waveOn = false; process.env.TB_WAVE = ''; } }
      if (waveOn) waveLog.push([cur.hwT - off0 - waveDrift, 'cycle ' + cur.k + ' ' + (cur.a ?? lastA).toString(16) + ' emuT ' + cur.emuT + ' w ' + cur.emuW, '']);
      rep.drift = d; prevK = cur.k; prevPc = cur.pc; prevA = cur.a ?? lastA;
      rep.cyc++;
      start(cur);
    } else { Tk++; act(cur, true); }
  } else if (cur) act(cur, false);
}
let prevK = '', prevPc = 0, prevA = 0;
let lastClkT = 0;
sim.watch[PIN.CLK] = (v, t) => { if (t - lastClkT < 60) { rep.clkGlitch = (rep.clkGlitch || 0) + 1; if (!rep.clkG1) rep.clkG1 = hwT(t); } lastClkT = t; edge(v === 0, t); };             // CLK = NOT pin 32
function start(c) {
  const k = c.k;
  if (k === 'ID') { sim.at(sim.t + D.addr, () => busA(lastA)); return; }
  sim.at(sim.t + D.addr, () => busA(c.a));
  act(c, true);
}
// Z80 bus timing (Zilog: M1 4 T, memory read/write 3 T, I/O 4 T with its automatic wait, interrupt acknowledge 6 T)
function act(c, rise) {
  const k = c.k, T = Tk;
  if (k === 'M1' || k === 'IA') {
    const w = k === 'IA' ? 2 : 0;
    if (!rise && T === 1 && !w) { ctl('MREQ', 0); ctl('RD', 0); }
    if (!rise && T === 3 && w) ctl('IORQ', 0);
    if (rise && T === 3 + w) {
      if (k === 'M1') check(c, cpuRead(c.a), 'M1');
      ctl('MREQ', 1); ctl('RD', 1); ctl('IORQ', 1); sim.at(sim.t + D.addr, () => busA(c.rf)); lastA = c.rf;
    }
    if (!rise && T === 3 + w) ctl('MREQ', 0);
    if (!rise && T === 4 + w) ctl('MREQ', 1);
  } else if (k === 'MR' || k === 'MW') {
    if (!rise && T === 1) { ctl('MREQ', 0); if (k === 'MR') ctl('RD', 0); else sim.at(sim.t + D.ctl, () => { cpuOut = c.d; dPins(); }); }
    if (!rise && T === 2 && k === 'MW') ctl('WR', 0);
    if (!rise && T === 3) {
      if (k === 'MR') check(c, cpuRead(c.a), 'MR');
      ctl('MREQ', 1); ctl('RD', 1); ctl('WR', 1); if (k === 'MW') sim.at(sim.t + D.ctl + 10, () => { cpuOut = null; dPins(); });
      lastA = c.a;
    }
    if (rise && T === 2) { const rs = sim.get(PIN.ROMCS); if (rs !== (c.a < 0x4000 ? 0 : 1)) rep.romcsBad.push({ a: c.a.toString(16), romcs: rs }); }
  } else if (k === 'IR' || k === 'IW') {
    if (rise && T === 2) { ctl('IORQ', 0); if (k === 'IR') ctl('RD', 0); else { ctl('WR', 0); sim.at(sim.t + D.ctl, () => { cpuOut = c.d; dPins(); }); } }
    if (!rise && T === 4) {
      if (k === 'IR') {
        const v = pinsVal(DP);
        if (c.a & 1) {   // the floating bus: Fuse reads it 3 T-states into the I/O cycle (src/spectrum.js at 1)
          const fs = m.floating(((Math.round(c.emuT) + 3) % SPEC.FRAME_T + SPEC.FRAME_T) % SPEC.FRAME_T);
          rep.floatN++; if (fs !== 0xFF || v !== 0xFF) rep.floatData = (rep.floatData || 0) + 1;
          if (v !== fs) rep.floatBad.push({ emuT: Math.round(c.emuT) % SPEC.FRAME_T, fuse: fs.toString(16), ula: v.toString(16) });
          if (v !== c.d) rep.floatEmu = (rep.floatEmu || 0) + 1;
        }
        else { rep.feN++; if ((v & 0x5F) !== (c.d & 0x5F)) rep.ioBad.push({ port: c.a.toString(16), emu: c.d.toString(16), ula: v.toString(16) }); }
      }
      ctl('IORQ', 1); ctl('RD', 1); ctl('WR', 1); if (k === 'IW') sim.at(sim.t + D.ctl + 10, () => { cpuOut = null; dPins(); });
      lastA = c.a;
    }
  }
}
function check(c, v, what) {
  if (c.a >= 0x4000 && c.a < 0x8000) { rep.lowN++; if (v !== c.d) rep.dataBad.push({ k: what, a: c.a.toString(16), emu: c.d.toString(16), ula: v.toString(16), emuT: Math.round(c.emuT) % SPEC.FRAME_T }); }
}

// ---- the picture: the colour lines into the encoder cell, sampled dot by dot ----
const venc = sim.els.find(e => e.type === 'venc');
const VN = ['N.BURST', 'BLUE*', 'N.RED*', 'N.GREEN*', 'RED*', 'N.GREEN*b', 'BURST*', 'N.BURST*', 'N.BLUE*', 'N.SYNC', "RED'", "BLUE'", "GREEN'", 'N.HL'];
const vlog = venc.ins.map(() => []);
venc.ins.forEach((n, i) => { const prev = sim.watch[n]; sim.watch[n] = (v, t) => { vlog[i].push([t, v]); if (prev) prev(v, t); }; });
const vInit = venc.ins.map(n => sim.get(n));

// TB_WAVE=frame T-state: log the transitions of TB_NETS from 2 T-states before it to 14 after (first frame only)
const waveLog = []; let waveOn = false, waveDrift = 0;
if (process.env.TB_WAVE) {
  const w0 = +process.env.TB_WAVE;
  for (const n of (process.env.TB_NETS || 'PN32_NBCPU,PN36_A14,PN38_NMREQ,PN3_NRD,PN2_NWR,PN33_NIORQ,PN35_NRAS,PN1_NCAS,PN4_NDRAMWE').split(',')) {
    const prev = sim.watch[n];
    sim.watch[n] = (v, t) => { if (waveOn) waveLog.push([hwT(t) - off0 - waveDrift, n, v]); if (prev) prev(v, t); };
  }
}
// the emulator's finished pictures, each with the absolute T-state its frame started at
const pics = [];
{ const ef = m.endFrame.bind(m); m.endFrame = function () { this.drawTo(SPEC.FRAME_T); pics.push({ t0: Math.floor(emuBase / SPEC.FRAME_T) * SPEC.FRAME_T, fb: this.fb.slice(), flash: this.flash }); ef(); }; }
// ---- run ----
const endT = startT + FRAMES * SPEC.FRAME_T * P;
const keyDown = startT + 0.5 * SPEC.FRAME_T * P;
let keyed = false;
while (sim.t < endT) {
  if (!keyed && sim.t > keyDown) { keyed = true; m.key('B', true); }  // B: half-row 7FFEh, read by the program's IN A,(C)
  stepTo(Math.min(endT, sim.t + 1000));
}
m.key('B', false);

// ---- report ----
const hist = a => { const h = {}; for (const x of a) h[x] = (h[x] || 0) + 1; return h; };
console.log(`ran ${FRAMES} frames: ${instr} instructions, ${rep.cyc} bus cycles, ${sim.events} gate events`);
console.log(`alignment: the first cycle started ${off0 && off0.toFixed(2)} T-states from where the emulator put it`);
console.log(`clock holds: ${rep.holdBad.length} cycles where the ULA held the CPU longer (+) or shorter (-) than the emulator`, hist(rep.holdBad.map(x => x.k + ' ' + x.extra)), rep.holdBad.slice(0, 6));
const iF = ints.filter(x => x[1] === 0).map(x => +hwT(x[0]).toFixed(2)), iR = ints.filter(x => x[1] === 1).map(x => +hwT(x[0]).toFixed(2));
if (rep.ph2) console.log('memory cycles to 4000h-7FFFh during the picture, by phase (T-state from 14,335, mod 8), and their holds:', Object.keys(rep.ph2).sort().map(k => k + ' (' + rep.ph2[k] + ')').join('; '));
console.log(`CPU clock pulses shorter than 60 ns: ${rep.clkGlitch || 0}, first at T ${rep.clkG1}`);
console.log(`INT: falls at T`, iF, 'rises at T', iR, `(T-state 0 is placed where the holds line up with the emulator's; then INT falls ${(-iF[0]).toFixed(2)} T-states before it. With the Z80 sampling INT at the start of an instruction's last T-state, an instruction starting at T-state ${Math.ceil(iF[0]) + 1} to ${Math.ceil(iR[0])} takes the interrupt: the emulator, like Fuse, says 0 to 31)`);
console.log(`CPU reads of the lower RAM: ${rep.lowN}, ${rep.dataBad.length} differ`, rep.dataBad.slice(0, 4));
console.log(`ROM select: ${rep.romcsBad.length} memory cycles wrong`, rep.romcsBad.slice(0, 3));
console.log(`port FE reads: ${rep.feN}, ${rep.ioBad.length} differ (bits 0-4, 6)`, rep.ioBad.slice(0, 4));
console.log(`floating bus (odd ports): ${rep.floatN} reads, ${rep.floatData || 0} of them with screen data; ${rep.floatBad.length} differ from Fuse's timing (the byte the ULA is fetching 3 T-states into the I/O cycle)`, rep.floatBad.slice(0, 4), `; src/spectrum.js reads it 2 T-states earlier and differs in ${rep.floatEmu || 0}`);
// the ULA's screen reads against the emulator's: each fetch's frame T-state (from CAS falling) and address
const fT = fetches.map(f => ({ ft: ((hwT(f.t) - off0) % SPEC.FRAME_T + SPEC.FRAME_T) % SPEC.FRAME_T, a: 0x4000 + f.off }));
let fBest = null;
for (let d = -3; d <= 3; d++) { let ok = 0; for (const f of fT) { const e = m.ulaFetch(Math.floor(f.ft) + d); if (e && e.addr === f.a) ok++; } if (!fBest || ok > fBest.ok) fBest = { d, ok }; }
console.log(`ULA screen reads: ${fetches.length}; ${fBest.ok} match the emulator's addresses taking the emulator's T-state as the CAS fall's ${fBest.d >= 0 ? '+' : ''}${fBest.d}`);
// ---- the picture: the colour lines into the encoder (GREEN', RED', BLUE', and N.HL for bright), dot by dot, against
// the emulator's picture of a frame the replay covered whole. The ULA's own delay is found as the best offset. Cells
// with the flash bit are left out (the ULA's flash counter starts wherever it starts) ----
{
  const VI = n => VN.indexOf(n), lv = (i, t) => { const e = vlog[i]; let lo = 0, hi = e.length - 1, v = vInit[i]; while (lo <= hi) { const mid = (lo + hi) >> 1; if (e[mid][0] <= t) { v = e[mid][1]; lo = mid + 1; } else hi = mid - 1; } return v; };
  const ix = ["GREEN'", "RED'", "BLUE'", 'N.HL'].map(VI);
  const p = pics.filter(q => rI + (q.t0 + off0) * P > startT && rI + (q.t0 + off0 + SPEC.FRAME_T) * P < sim.t).pop();
  if (p) {
    const colourAt = t => { let c = lv(ix[0], t) * 4 + lv(ix[1], t) * 2 + lv(ix[2], t); if (c && !lv(ix[3], t)) c += 8; return c; };
    const tOf = (y, x, off) => { const line = y + SPEC.FIRST, ft = SPEC.DISP_T + (line - 64) * SPEC.LINE_T + ((x >> 3) - 6) * 4 + (x & 7) / 2; return rI + (p.t0 + ft + off0) * P + (off + 0.5) * P / 2; };
    const flashCell = (y, x) => { const l = y + SPEC.FIRST - 64; if (l < 0 || l >= 192 || x < 48 || x >= 304) return false; return (m.ram[0x1800 + (l >> 3) * 32 + ((x - 48) >> 3)] & 0x80) !== 0; };
    let best = null;
    for (let off = -4; off <= 24; off++) { let ok = 0, n = 0; for (let y = 0; y < SPEC.FH; y += 7) for (let x = 0; x < SPEC.FW; x += 3) { if (flashCell(y, x)) continue; n++; if (colourAt(tOf(y, x, off)) === (p.fb[y * SPEC.FW + x] & 7 ? p.fb[y * SPEC.FW + x] : 0)) ok++; } if (!best || ok > best.ok) best = { off, ok, n }; }
    let bad = 0, n = 0, badB = 0, nB = 0;
    for (let y = 0; y < SPEC.FH; y++) for (let x = 0; x < SPEC.FW; x++) { if (flashCell(y, x)) continue; const l = y + SPEC.FIRST - 64, pic = l >= 0 && l < 192 && x >= 48 && x < 304; const want = p.fb[y * SPEC.FW + x] & 7 ? p.fb[y * SPEC.FW + x] : 0, okc = colourAt(tOf(y, x, best.off)) === want; if (pic) { n++; if (!okc) bad++; } else { nB++; if (!okc) { badB++; if (x < 48 && !colourAt(tOf(y, x, best.off))) rep.blank = (rep.blank || 0) + 1; else (rep.bx = rep.bx || []).length < 6 && rep.bx.push([y, x, colourAt(tOf(y, x, best.off)), want]); if (process.env.TB_BORDER) (rep.bl = rep.bl || {})[y] = (rep.bl[y] || '') + (rep.bl[y] && rep.bl[y].length > 40 ? '' : x + ':' + colourAt(tOf(y, x, best.off)) + '/' + want + ' '); } } }
    if (rep.bl) for (const y of Object.keys(rep.bl).slice(0, 12)) console.log('border line', y, rep.bl[y]);
    console.log(`picture (frame from T-state ${p.t0}): the ULA's dots come ${best.off} dots after the emulator's; picture ${bad} of ${n} dots differ, border ${badB} of ${nB}: ${rep.blank || 0} of them black at the left edge, where the ULA is still blanking; others:`, rep.bx || []);
  } else console.log('picture: no whole frame in the run (run 3 frames or more)');
}
if (waveLog.length) for (const [ft, n, v] of waveLog) console.log(ft.toFixed(3), n, v);
module.exports = { startT, pics, SPEC, rasLog, sim, m, vlog, vInit, VN, venc, rI, off0, P, OSC, hwT, fetches };
if (process.env.TB_PIC) require('./tbpic.js')(module.exports);
