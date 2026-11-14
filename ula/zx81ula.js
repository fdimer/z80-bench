// ---- A ZX81 whose ULA is the real logic: the Z80 core on the board's wiring, the ULA in charge ----
// Nothing of the ULA is modelled here. The Z80's bus cycles are put on the ULA's pins as waveforms, T-state by
// T-state, timed from the clock the ULA itself puts out; and everything the Z80 and the TV get comes back from the
// ULA's pins: the byte on the data lines (so the NOPs), NMI, the memory selects, the font address, sync and video.
// The ULA is one of the engines of this folder: the netlist in sim.js (UlaSim) or the synchronous Verilog (SyncUla
// in v2js.js). Both are driven the same way: set(pin, level), get(pin), runTo(ns), watch[pin].
//
// The board (Sinclair's circuit diagram), as far as the ULA is concerned:
//   A0-A8 reach the memory through 1K resistors, on the ULA's side of them (A0'-A8'); D0-D7 reach it through 470
//     ohms, the ULA on the Z80's side. So what the ULA drives wins on its side.
//   The ROM drives the data lines whenever ROM CS is low; the RAM whenever RAM CS is low and WR is high.
//   INT is A6. WAIT is low while NMI and HALT are both low (so a halted Z80 takes the NMI as its pulse ends).
//   CLK is the ULA's clock output through TR2, inverted.
// Z80 timing is the data sheet's shape with fixed delays (addr, ctl); memory answers after acc.
// Simplifications: the RAM is one block of 1K to 16K on RAM CS (a RAM pack decodes for itself); there is no tape.

const ZX81ULA_KEYS = [
  ['Shift', 'Z', 'X', 'C', 'V'], ['A', 'S', 'D', 'F', 'G'], ['Q', 'W', 'E', 'R', 'T'], ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'], ['P', 'O', 'I', 'U', 'Y'], ['NewLine', 'L', 'K', 'J', 'H'], ['Space', '.', 'M', 'N', 'B']
];

class Zx81Ula {
  // Z80: the CPU class of src/z80core.js; engine: the ULA; rom: the 8K ROM image (not kept in the repository)
  constructor(Z80, engine, rom, opts = {}) {
    this.u = engine; this.rom = rom; this.ram = new Uint8Array(0x4000); this.ramSize = opts.ramSize || 0x4000;
    this.D = Object.assign({ addr: 40, ctl: 30, acc: 150 }, opts.delays || {});
    this.OSC = 1000 / 6.5; this.P2 = 2 * this.OSC;
    this.oscT = 0; this.osc = 0; this.q = [];      // testbench queue: [time, fn], kept sorted
    this.keys = new Uint8Array(8);
    this.cpuA = 0; this.zD = -1;                    // the Z80's address; the byte it drives on the data lines (-1: none)
    this.mem = 0xFF;                                // what the memory drives (FFh: nothing)
    // the TV: one sample per dot; a short sync ends a line, a long one a frame
    this.W = 414; this.H = 312; this.fb = new Uint8Array(this.W * this.H); this.frame = new Uint8Array(this.W * this.H);
    this.x = 0; this.y = 0; this.syncLen = 0; this.frames = 0; this.onFrame = null;
    this.nmiAt = null; this.r1 = null; this.waits = 0; this.nmis = 0; this.ints = 0;
    const u = this.u;
    u.watch['N.PHI'] = (v, t) => { if (v === 0 && this.r1 === null) this.r1 = t; };
    u.watch['N.NMI'] = (v, t) => { if (v === 0) this.nmiAt = t; };
    u.watch['ROM.N.CS'] = u.watch['RAM.N.CS'] = () => this.memLater();
    for (const p of ['nMREQ', 'nM1', 'nRD', 'nWR', 'nIORQ', 'nHALT']) u.set(p, 1);
    this.adv(3000); if (this.r1 === null) throw new Error('the ULA puts out no clock');
    this.T = Math.floor((this.u.t - this.r1) / this.P2) + 3;       // the T-state the next cycle starts in (CLK rises at rise(T))
    this.cpu = new Z80(this); this.done = 0; this.lastA = 0xFFFF; this.tape = null;
  }
  rise(k) { return this.r1 + (k - 1) * this.P2; }
  fall(k) { return this.rise(k) + this.OSC; }
  at(t, f) { const q = this.q; let i = q.length; while (i && q[i - 1][0] > t) i--; q.splice(i, 0, [t, f]); }
  // run the oscillator, the queued bus edges and the TV up to time t
  adv(t) {
    const u = this.u, q = this.q;
    for (;;) {
      const no = this.oscT + this.OSC / 2, nq = q.length ? q[0][0] : Infinity;
      if (nq <= no && nq <= t) { u.runTo(nq); q.shift()[1](); continue; }
      if (no <= t) { u.runTo(no); this.oscT = no; this.osc ^= 1; if (this.osc) this.dot(); u.set('OSC', this.osc); continue; }
      u.runTo(t); return;
    }
  }
  dot() {                                           // just before the dot clock: the dot now on the TV/TAPE pin
    const v = this.u.get('TV/TAPE');
    if (v === 0) { this.syncLen++; return; }
    if (this.syncLen) {
      if (this.syncLen > 200) { this.frame.set(this.fb); this.fb.fill(0); this.y = 0; this.frames++; if (this.onFrame) this.onFrame(this.frame); }
      else if (++this.y >= this.H) this.y = 0;      // no vertical sync: the picture rolls
      this.x = 0; this.syncLen = 0;
    }
    if (this.x < this.W) this.fb[this.y * this.W + this.x++] = v;      // 1 black, 2 white
  }
  // ---- the pins ----
  setA(a) { const u = this.u; this.cpuA = a; for (let n = 0; n < 9; n++) u.set(`A${n}'`, a >> n & 1); u.set('nA14', a >> 14 & 1); u.set('nA15', a >> 15 & 1); this.memLater(); }
  aLow() { let v = 0; for (let n = 0; n < 9; n++) v |= this.u.get(`A${n}'`) << n; return v; }
  dBus() { let v = 0; for (let n = 0; n < 8; n++) v |= this.u.get('nD' + n) << n; return v; }      // the Z80's side of the data lines
  drive() { const v = this.zD >= 0 ? this.zD : this.mem; for (let n = 0; n < 8; n++) this.u.set('nD' + n, v >> n & 1); }
  memAddr() { return (this.cpuA & 0xFE00) | this.aLow(); }
  memLater() { this.at(this.u.t + this.D.acc, () => this.memNow()); }
  memNow() {
    const u = this.u, a = this.memAddr();
    this.mem = u.get('ROM.N.CS') === 0 ? this.rom[a & 0x1FFF] : u.get('RAM.N.CS') === 0 && u.get('nWR') ? this.ram[a & (this.ramSize - 1)] : 0xFF;
    this.drive();
  }
  ctl(p, v) { this.u.set(p, v); }
  // WAIT, as the Z80 samples it on the falling edge of T2 (and of each wait state): stretch the cycle while it is low
  waitAt(s, k) { for (;;) { this.adv(this.fall(s + k - 1) - 2); if (this.u.get('N.NMI') === 0 && this.u.get('nHALT') === 0) { s++; this.waits++; } else return s; } }
  // ---- the Z80's machine cycles; each runs to its end and leaves T at the next cycle's first T-state ----
  m1(a, halt, rf) {
    let s = this.T; const D = this.D;
    this.at(this.rise(s) + D.addr, () => { this.setA(a); this.ctl('nM1', 0); this.ctl('nHALT', halt ? 0 : 1); });
    this.at(this.fall(s) + D.ctl, () => { this.ctl('nMREQ', 0); this.ctl('nRD', 0); });
    s = this.waitAt(s, 2);
    this.adv(this.rise(s + 2) - 2); const d = this.dBus();          // T3: the Z80 takes the opcode
    this.at(this.rise(s + 2) + D.ctl, () => { this.ctl('nMREQ', 1); this.ctl('nRD', 1); this.ctl('nM1', 1); });
    this.at(this.rise(s + 2) + D.addr, () => this.setA(rf));
    this.at(this.fall(s + 2) + D.ctl, () => this.ctl('nMREQ', 0));
    this.at(this.fall(s + 3) + D.ctl, () => this.ctl('nMREQ', 1));
    this.T = s + 4; this.adv(this.rise(this.T)); this.lastA = rf; return d;
  }
  intack(a, rf) {
    const s = this.T, D = this.D; this.ints++;
    this.at(this.rise(s) + D.addr, () => { this.setA(a); this.ctl('nM1', 0); this.ctl('nHALT', 1); });
    this.at(this.fall(s + 2) + D.ctl, () => this.ctl('nIORQ', 0));
    this.at(this.rise(s + 4) + D.ctl, () => { this.ctl('nIORQ', 1); this.ctl('nM1', 1); });
    this.at(this.rise(s + 4) + D.addr, () => this.setA(rf));
    this.at(this.fall(s + 4) + D.ctl, () => this.ctl('nMREQ', 0));
    this.at(this.fall(s + 5) + D.ctl, () => this.ctl('nMREQ', 1));
    this.T = s + 6; this.adv(this.rise(this.T)); this.lastA = rf;
  }
  mrd(a) {
    let s = this.T; const D = this.D;
    this.at(this.rise(s) + D.addr, () => this.setA(a));
    this.at(this.fall(s) + D.ctl, () => { this.ctl('nMREQ', 0); this.ctl('nRD', 0); });
    s = this.waitAt(s, 2);
    this.adv(this.fall(s + 2) - 2); const d = this.dBus();
    this.at(this.fall(s + 2) + D.ctl, () => { this.ctl('nMREQ', 1); this.ctl('nRD', 1); });
    this.T = s + 3; this.adv(this.rise(this.T)); this.lastA = a; return d;
  }
  mwr(a, v) {
    let s = this.T; const D = this.D;
    this.at(this.rise(s) + D.addr, () => this.setA(a));
    this.at(this.fall(s) + D.ctl, () => { this.ctl('nMREQ', 0); this.zD = v; this.drive(); });
    this.at(this.fall(s + 1) + D.ctl, () => { this.ctl('nWR', 0); this.memLater(); });
    s = this.waitAt(s, 2);
    this.adv(this.fall(s + 2) - 2);                                // WR about to rise: the RAM, if selected, takes the byte
    if (this.u.get('RAM.N.CS') === 0 && this.u.get('nWR') === 0) this.ram[this.memAddr() & (this.ramSize - 1)] = this.dBus();
    this.at(this.fall(s + 2) + D.ctl, () => { this.ctl('nMREQ', 1); this.ctl('nWR', 1); this.zD = -1; this.drive(); this.memLater(); });
    this.T = s + 3; this.adv(this.rise(this.T)); this.lastA = a;
  }
  io(a, v) {                                        // v undefined: a read
    const s = this.T, D = this.D, rd = v === undefined;
    let kb = 0x1F; for (let r = 0; r < 8; r++) if (!(a & (0x100 << r))) kb &= ~this.keys[r] & 0x1F;
    this.at(this.rise(s) + D.addr, () => { this.setA(a); for (let n = 0; n < 5; n++) this.u.set('nKB' + n, kb >> n & 1); if (!rd) { this.zD = v; this.drive(); } });
    this.at(this.rise(s + 1) + D.ctl, () => { this.ctl('nIORQ', 0); this.ctl(rd ? 'nRD' : 'nWR', 0); });
    this.adv(this.fall(s + 3) - 2); const d = this.dBus();
    this.at(this.fall(s + 3) + D.ctl, () => { this.ctl('nIORQ', 1); this.ctl('nRD', 1); this.ctl('nWR', 1); this.zD = -1; this.drive(); });
    this.T = s + 4; this.adv(this.rise(this.T)); this.lastA = a; return d;
  }
  // cycles the core logged without calling the bus: idle T-states and the interrupt acknowledge
  flush() {
    const c = this.cpu.cyc;
    for (; this.done < c.length; this.done++) { const x = c[this.done]; if (x.k === 'ID') { this.T += x.n; this.adv(this.rise(this.T)); } else if (x.k === 'IA') this.intack(x.a, x.rf); }
  }
  // ---- the bus as src/z80core.js calls it ----
  rfsh() { return this.cpu.i << 8 | this.cpu.r; }
  fetch(a) { this.flush(); const d = this.m1(a, false, this.rfsh()); this.done++; return d; }
  read(a) {
    this.flush();
    // the core reads the opcode of an NMI response and of a halted Z80's cycles with read(): they are M1 cycles
    const d = this.cpu.cyc.length === 0 ? this.m1(a, this.cpu.halted, this.rfsh()) : this.mrd(a);
    this.done++; return d;
  }
  write(a, v) { this.flush(); this.mwr(a, v); this.done++; }
  input(p) { this.flush(); const d = this.io(p); this.done++; return d; }
  output(p, v) { this.flush(); this.io(p, v); this.done++; }
  // one instruction. NMI: its falling edge, if it came before the last T-state began. INT: A6, as that T-state begins.
  step() {
    const cpu = this.cpu;
    // LOAD: the tape is not modelled; the ROM's byte reader (034Ch) is replaced, as in zx81fast.js
    if (cpu.pc === 0x034C && this.tape && !cpu.halted && this.rom[0x34C] === 0x0E && this.rom[0x207] === 0x21) {
      this.loadP(this.tape); this.tape = null; cpu.sp = (cpu.sp + 2) & 0xFFFF; cpu.pc = 0x0207;
    }
    if (this.nmiAt !== null && this.nmiAt <= this.rise(this.T - 1)) { cpu.nmiPending = true; this.nmiAt = null; this.nmis++; }
    cpu.intLine = !(this.lastA & 0x40);
    this.done = 0; cpu.step(); this.flush();
  }
  run(tStates) { const end = this.T + tStates; while (this.T < end) this.step(); }
  key(name, down) { for (let r = 0; r < 8; r++) { const b = ZX81ULA_KEYS[r].indexOf(name); if (b >= 0) { this.keys[r] = down ? this.keys[r] | 1 << b : this.keys[r] & ~(1 << b); return true; } } return false; }
  // a .p file is RAM from 4009h up to E_LINE (which it holds at 4014h)
  loadP(b) { const n = Math.min(b.length, (b[0x0B] | b[0x0C] << 8) - 0x4009, this.ramSize - 9); this.ram.set(b.subarray(0, n), 9); }
}
if (typeof module !== 'undefined') module.exports = { Zx81Ula, ZX81ULA_KEYS };
