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
const FRAMES = +(process.argv[2] || 2);
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
const sim = new Ula6cSim(fs.readFileSync(path.join(__dirname, '6c001.net'), 'utf8'));
const OSC = 1000 / 14, P = 4 * OSC;                       // ns per oscillator period, per T-state
const D = { addr: +(process.env.TB_ADDR || 40), ctl: +(process.env.TB_CTL || 30), cac: +(process.env.TB_CAC || 100), off: 20 };
const PIN = { A14: 'PN36_A14', A15: 'PN37_A15', MREQ: 'PN38_NMREQ', RD: 'PN3_NRD', WR: 'PN2_NWR', IORQ: 'PN33_NIORQ',
  CLK: 'PN32_NBCPU', INT: 'PN12_NINT', RAS: 'PN35_NRAS', CAS: 'PN1_NCAS', WE: 'PN4_NDRAMWE', ROMCS: 'PN34_NROMCS', EAR: 'PN28_TAPELS' };
const AP = ['PN5_A0', 'PN6_A1', 'PN7_A2', 'PN8_A3', 'PN9_A4', 'PN10_A5', 'PN11_A6'];
const DP = ['PN18_D0', 'PN21_D1', 'PN22_D2', 'PN25_D3', 'PN27_D4', 'PN29_D5', 'PN30_D6', 'PN31_D7'];
const KP = ['PN19_KB0', 'PN20_KB1', 'PN23_KB2', 'PN24_KB3', 'PN26_KB4'];
for (const n of ['MREQ', 'RD', 'WR', 'IORQ']) sim.set(PIN[n], 1);
const aDriver = sim.drivers[AP[0]].map(([e]) => e).find(e => e.type === 'pin_ts');
const ulaDrivesA = () => aDriver.drive[0] !== null;
const pinsVal = (names) => names.reduce((v, n, i) => v | ((sim.get(n) ?? 1) & 1) << i, 0);

// the CPU's address: A14, A15 straight to the ULA; A0-A6 through IC3/IC4 and 330 ohms (the ULA's own drive wins);
// the keyboard joins a half-row (A8-A15, the one held low) to KB0-KB4
let cpuA = 0;
const keyCols = a => { let v = 0x1F; for (let r = 0; r < 8; r++) if (!(a & (0x100 << r))) v &= ~m.keys[r] & 0x1F; return v; };
function busA(a) {
  cpuA = a; sim.set(PIN.A14, a >> 14 & 1); sim.set(PIN.A15, a >> 15 & 1);
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
// else the CPU's A0-A6 then A7-A13 through the multiplexers); the data appears tCAC after CAS falls and goes D.off after
// it rises; a write takes the data pins' value when WE and CAS are both low ----
const ram = m.ram;                                         // 4000h-7FFFh is ram[0..3FFF]
let row = 0, rasLow = false, casLow = false, dseq = 0;
const fetches = [], cpuDram = [];
const rasLog = [];
sim.watch[PIN.RAS] = (v) => { rasLow = !v; if (!v) { row = ulaDrivesA() ? pinsVal(AP) : cpuA & 0x7F; if (process.env.TB_DBG && rasLog.length < 400) { const t = sim.t, r0 = row; const s = []; for (const d of [-20, -5, 5, 15, 30]) sim.at(t + d < t ? t : t + d, () => s.push(pinsVal(AP))); rasLog.push({ t, r0, s }); } } };
function dramWrite(off) { const v = pinsVal(DP); ram[off] = v; cpuDram.push({ t: sim.t, off, w: v }); }
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
const cpuRead = (a) => a < 0x4000 ? (sim.get(PIN.ROMCS) === 0 ? m.rom[a] : 0xFF) : a < 0x8000 ? pinsVal(DP) : ram[a - 0x4000];

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
// T-state 0, as the emulator (and Fuse) count: the Z80 samples INT on the rising edge of the last T-state of an
// instruction, so an instruction starting at T-state t sees INT as it was at the rise of t-1. INT falls during the
// T-state before the first rise that sees it low; that rise is T-state -1.
rI = firstRise + P;
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
const ctl = (n, v, dt = D.ctl) => sim.at(sim.t + dt, () => sim.set(PIN[n], v));
function edge(rise, t) {
  if (rise) {
    if (!cur || Tk >= cur.len) {
      while (Q.length < 2) feed();
      if (cur && (cur.k === 'M1' || cur.k === 'MR' || cur.k === 'MW')) {   // the hold the ULA gave the cycle just ended, by where it started
        const ft = ((cur.hwT % SPEC.FRAME_T) + SPEC.FRAME_T) % SPEC.FRAME_T, r = ft - 14335, line = Math.floor(r / 224), x = r % 224;
        const hold = +(hwT(t) - cur.hwT - cur.len).toFixed(2);
        if (r >= 0 && line < 192 && x < 136 && (cur.a & 0xC000) === 0x4000) (rep.phase = rep.phase || {})[`${Math.floor(x / 8) < 16 ? Math.round(x) % 8 : 'x' + Math.round(x)} hw ${hold}`] = ((rep.phase || {})[`${Math.floor(x / 8) < 16 ? Math.round(x) % 8 : 'x' + Math.round(x)} hw ${hold}`] || 0) + 1;
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
  } else act(cur, false);
}
let prevK = '', prevPc = 0, prevA = 0;
sim.watch[PIN.CLK] = (v, t) => edge(v === 0, t);             // CLK = NOT pin 32
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
        if (c.a & 1) { (rep.fl = rep.fl || []).push({ hw: c.hwT, v, cas: sim.get(PIN.CAS), ras: sim.get(PIN.RAS), dram: dramOut, now: hwT(sim.t) - c.hwT }); rep.floatN++; if (c.d !== 0xFF || v !== 0xFF) rep.floatData = (rep.floatData || 0) + 1; if (v !== c.d) rep.floatBad.push({ emuT: Math.round(c.emuT) % SPEC.FRAME_T, emu: c.d.toString(16), ula: v.toString(16) }); }
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
console.log('contended memory cycles in hw: phase (T-state from 14,335, mod 8) and the hold', rep.phase);
console.log(`INT: falls at T`, iF, 'rises at T', iR);
console.log(`CPU reads of the lower RAM: ${rep.lowN}, ${rep.dataBad.length} differ`, rep.dataBad.slice(0, 4));
console.log(`ROM select: ${rep.romcsBad.length} memory cycles wrong`, rep.romcsBad.slice(0, 3));
console.log(`port FE reads: ${rep.feN}, ${rep.ioBad.length} differ (bits 0-4, 6)`, rep.ioBad.slice(0, 4));
console.log(`floating bus reads (odd port): ${rep.floatN} (${rep.floatData || 0} not FFh), ${rep.floatBad.length} differ`, rep.floatBad.slice(0, 4));
{ // the floating bus: which emulator T-state convention (IO cycle start + 1 + d) reproduces what the ULA's bus held
  const fl = (rep.fl || []).filter(x => x.v !== 0xFF || true); let out = [];
  for (let d = -4; d <= 4; d++) { let ok = 0; for (const x of fl) if (m.floating(((Math.round(x.hw - off0) + 1 + d) % SPEC.FRAME_T + SPEC.FRAME_T) % SPEC.FRAME_T) === x.v) ok++; out.push(d + ':' + ok); }
  console.log(`floating bus, by the ULA's own timing: reads matching floating(IO start + 1 + d), of ${fl.length} (${fl.filter(x => x.v !== 0xFF).length} not FFh):`, out.join(' '));
}
// the ULA's screen reads against the emulator's: each fetch's frame T-state (from CAS falling) and address
const fT = fetches.map(f => ({ ft: ((hwT(f.t) - off0) % SPEC.FRAME_T + SPEC.FRAME_T) % SPEC.FRAME_T, a: 0x4000 + f.off }));
let fBest = null;
for (let d = -3; d <= 3; d++) { let ok = 0; for (const f of fT) { const e = m.ulaFetch(Math.floor(f.ft) + d); if (e && e.addr === f.a) ok++; } if (!fBest || ok > fBest.ok) fBest = { d, ok }; }
console.log(`ULA screen reads: ${fetches.length}; ${fBest.ok} match the emulator's addresses taking the emulator's T-state as the CAS fall's ${fBest.d >= 0 ? '+' : ''}${fBest.d}`);
if (waveLog.length) for (const [ft, n, v] of waveLog) console.log(ft.toFixed(3), n, v);
if (process.env.TB_FL) console.log(JSON.stringify((rep.fl||[]).slice(0,30)));
module.exports = { rasLog, sim, m, vlog, vInit, VN, venc, rI, off0, P, OSC, hwT, fetches };
if (process.env.TB_PIC) require('./tbpic.js')(module.exports);
