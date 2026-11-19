// ---- A ZX Spectrum 48K whose ULA is the real logic: the Z80 core on the board's wiring, the ULA in charge ----
// Nothing of the ULA is modelled here. The Z80's bus cycles are put on the ULA's pins as waveforms, edge by edge of
// the clock the ULA itself puts out, so when the ULA holds the clock (contention) the Z80 simply waits. Everything the
// Z80 and the TV get comes from the ULA's pins: the lower RAM's data (read through the ULA's RAS, CAS and DRAMWE), the
// ROM select, port FE, the floating bus, INT, and the colour lines that go to the encoder.
// The ULA is one of the engines of this folder (ula6c/sim.js or ula6c/fastsim.js): set(pin, level), get(pin),
// runTo(ns), at(ns, fn), watch[net], drivesPin(net), els.
//
// The board (Timex's issue 6A circuit diagram), as far as the ULA is concerned:
//   CLK is pin 32 inverted by TR3. INT is pin 12.
//   A14, A15, MREQ, RD, WR go straight to the ULA. IORQ goes through R27 (470 ohms) and TR6, an emitter follower from
//     A0, holds it high while A0 is high: the ULA sees I/O requests for even ports only.
//   A0-A6 reach the lower RAM's address pins, and the ULA's, through IC3/IC4 and 330 ohms: the ULA's own drive wins.
//   D0-D7 reach the ULA's data pins, which are the lower RAM's data lines, through 470 ohms (R1-R8).
//   The lower RAM: eight 4116s, row on RAS falling, column on CAS falling, written when WE and CAS are both low. After
//     CAS rises the data lines keep the last byte for a while (they hold their charge until something drives them).
//   The keyboard joins a half-row (A8-A15, the one held low) to KB0-KB4. The EAR pin reads high while the ULA drives
//     its EAR output (issue 3 and later); there is no tape.
//   The upper RAM (8000h-FFFFh) and the ROM are on the Z80's side; the ROM answers while ROMCS is low.
// Z80 timing is the data sheet's shape with fixed delays after each clock edge: address 40 ns, control 30 ns.

const SPECULA_KEYS = [['CAPS SHIFT', 'Z', 'X', 'C', 'V'], ['A', 'S', 'D', 'F', 'G'], ['Q', 'W', 'E', 'R', 'T'], ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'], ['P', 'O', 'I', 'U', 'Y'], ['ENTER', 'L', 'K', 'J', 'H'], ['SPACE', 'SYMBOL SHIFT', 'M', 'N', 'B']];
const SPECULA_VN = ['N.BURST', 'BLUE*', 'N.RED*', 'N.GREEN*', 'RED*', 'N.GREEN*b', 'BURST*', 'N.BURST*', 'N.BLUE*', 'N.SYNC', "RED'", "BLUE'", "GREEN'", 'N.HL'];

class SpecUla {
  constructor(Z80, engine, rom, opts = {}) {
    const u = this.u = engine; this.rom = rom;
    this.ram = new Uint8Array(0xC000);            // 4000h-FFFFh; the first 16K is the lower RAM (the 4116s)
    for (let i = 0; i < this.ram.length; i++) this.ram[i] = (i >> 7) & 1 ? 0xFF : 0x00;   // power on: a pattern
    this.D = Object.assign({ addr: 40, ctl: 30, cac: 100, hold: 150 }, opts.delays || {});
    this.OSC = 1000 / 14; this.oscT = 0; this.osc = 0;
    this.keys = new Uint8Array(8);
    this.P = { A14: 'PN36_A14', A15: 'PN37_A15', MREQ: 'PN38_NMREQ', RD: 'PN3_NRD', WR: 'PN2_NWR', IORQ: 'PN33_NIORQ', CLK: 'PN32_NBCPU',
      INT: 'PN12_NINT', RAS: 'PN35_NRAS', CAS: 'PN1_NCAS', WE: 'PN4_NDRAMWE', ROMCS: 'PN34_NROMCS', EAR: 'PN28_TAPELS', OSC: 'PN39_OSC' };
    this.AP = ['PN5_A0', 'PN6_A1', 'PN7_A2', 'PN8_A3', 'PN9_A4', 'PN10_A5', 'PN11_A6'];
    this.DP = ['PN18_D0', 'PN21_D1', 'PN22_D2', 'PN25_D3', 'PN27_D4', 'PN29_D5', 'PN30_D6', 'PN31_D7'];
    this.KP = ['PN19_KB0', 'PN20_KB1', 'PN23_KB2', 'PN24_KB3', 'PN26_KB4'];
    for (const n of ['MREQ', 'RD', 'WR', 'IORQ']) u.set(this.P[n], 1);
    this.cpuA = 0; this.iorqN = 1; this.cpuOut = null; this.dramOut = null; this.lastA = 0;
    // counters for the meters
    this.T = 0; this.ints = 0; this.holds = 0; this.frames = 0; this.cycles = 0;
    // the clock: CLK = NOT pin 32. Edge handler runs the bus cycle in progress.
    this.cur = null; this.rises = 0; this.intNow = 1; this.intPrev = 1; this.tRise = 0;
    u.watch[this.P.CLK] = (v, t) => this.clkEdge(v === 0, t);
    // the lower RAM
    this.row = 0; this.rasLow = false; this.casLow = false; this.dseq = 0; this.casOff = 0;
    u.watch[this.P.RAS] = (v) => { this.rasLow = !v; if (!v) this.row = u.drivesPin(this.AP[0]) ? this.pins(this.AP) : this.cpuA & 0x7F; };
    u.watch[this.P.CAS] = (v) => this.casEdge(v);
    u.watch[this.P.WE] = (v) => { if (v === 0 && this.casLow && this.rasLow) this.dramWrite(this.casOff); };
    // the EAR pin follows the ULA's EAR output (issue 3 and later)
    const tc = u.els.find(e => e.type === 'tapecell'); this.nLS = tc.ins[0];
    u.watch[this.nLS] = (v) => u.set(this.P.EAR, v ? 0 : 1); u.set(this.P.EAR, u.get(this.nLS) ? 0 : 1);
    // the TV: the colour lines into the encoder cell, one sample per dot
    const ve = u.els.find(e => e.type === 'venc'); const VI = n => ve.ins[SPECULA_VN.indexOf(n)];
    this.vG = VI("GREEN'"); this.vR = VI("RED'"); this.vB = VI("BLUE'"); this.vHL = VI('N.HL'); this.vSync = VI('N.SYNC');
    this.W = 448; this.H = 312; this.fb = new Uint8Array(this.W * this.H); this.frame = new Uint8Array(this.W * this.H);
    this.x = 0; this.y = 0; this.syncLen = 0; this.onFrame = null; this.lastLines = 0; this.dotPhase = 0;
    this.keysToPins();
    this.adv(2000);
    this.cpu = new Z80(this); this.cpu.intVector = 0xFF;
    const cpu = this.cpu, bus = this;
    cpu.fetch = function () {                       // the core reads opcodes with read(): mark them as M1 cycles
      const a = this.pc; bus.m1Next = true; const v = bus.read(a);
      if (this.log) this.cyc.push({ k: 'M1', a, d: v, rf: (this.i << 8) | this.r });
      this.pc = (a + 1) & 0xFFFF; this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F); return v;
    };
    this.done = 0;
    this.waitRise();                                // start in step with the clock
  }
  // ---- time ----
  adv(t) {                                          // run the oscillator and the ULA up to time t (ns)
    const u = this.u, H = this.OSC / 2;
    for (;;) {
      const no = this.oscT + H;
      if (no > t) { u.runTo(t); return; }
      u.runTo(no); this.oscT = no; this.osc ^= 1; u.set(this.P.OSC, this.osc);
      if (this.osc) this.sample();
    }
  }
  waitRise() { const r = this.rises; while (this.rises === r) this.adv(this.u.t + this.OSC / 4); }
  // ---- pins ----
  pins(names) { let v = 0; for (let n = 0; n < names.length; n++) v |= (this.u.get(names[n]) & 1) << n; return v; }
  keysToPins() { let k = 0x1F; for (let r = 0; r < 8; r++) if (!(this.cpuA & (0x100 << r))) k &= ~this.keys[r] & 0x1F; for (let n = 0; n < 5; n++) this.u.set(this.KP[n], k >> n & 1); }
  setA(a) {
    const u = this.u; this.cpuA = a;
    u.set(this.P.A14, a >> 14 & 1); u.set(this.P.A15, a >> 15 & 1);
    for (let n = 0; n < 7; n++) u.set(this.AP[n], a >> n & 1);
    this.keysToPins(); this.ulaIorq();
  }
  ulaIorq() { this.u.set(this.P.IORQ, this.iorqN | (this.cpuA & 1)); }      // TR6
  dPins() { const v = this.dramOut ?? this.cpuOut ?? 0xFF; for (let n = 0; n < 8; n++) this.u.set(this.DP[n], v >> n & 1); }
  later(dt, f) { this.u.at(this.u.t + dt, f); }
  ctl(n, v) { this.later(this.D.ctl, () => { if (n === 'IORQ') { this.iorqN = v; this.ulaIorq(); } else this.u.set(this.P[n], v); }); }
  // ---- the lower RAM ----
  casEdge(v) {
    const u = this.u; this.casLow = !v; const my = ++this.dseq;
    if (!v) {
      if (!this.rasLow) return;
      const col = u.drivesPin(this.AP[0]) ? this.pins(this.AP) : this.cpuA >> 7 & 0x7F; this.casOff = this.row | col << 7;
      if (u.get(this.P.WE) === 0) { this.dramWrite(this.casOff); return; }
      this.later(this.D.cac, () => { if (this.dseq === my && this.casLow) { this.dramOut = this.ram[this.casOff]; this.dPins(); } });
    } else this.later(this.D.hold, () => { if (this.dseq === my) { this.dramOut = null; this.dPins(); } });
  }
  dramWrite(off) { this.dramOut = null; this.dPins(); this.dseq++; this.ram[off] = this.pins(this.DP); }
  // what the Z80 sees on its data lines
  cpuRead(a) { return a < 0x4000 ? (this.u.get(this.P.ROMCS) === 0 ? this.rom[a] : 0xFF) : a < 0x8000 ? this.pins(this.DP) : this.ram[a - 0x4000]; }
  // ---- the TV ----
  sample() {                                        // each oscillator period: the colour lines and sync, as the encoder sees them
    const u = this.u;
    if (u.get(this.vSync) === 0) { this.syncLen++; return; }
    if (this.syncLen) {
      if (this.syncLen > 300) {                     // a long sync: the vertical sync, the frame ends
        this.frame.set(this.fb); this.lastLines = this.y; this.fb.fill(0); this.y = 0; this.frames++; if (this.onFrame) this.onFrame(this.frame);
      } else if (++this.y >= this.H) this.y = 0;
      this.x = 0; this.syncLen = 0;
    }
    const xx = this.x++ >> 1; if (xx >= this.W) return;
    let c = u.get(this.vG) * 4 + u.get(this.vR) * 2 + u.get(this.vB); if (c && !u.get(this.vHL)) c += 8;
    this.fb[this.y * this.W + xx] = c;
  }
  // ---- the clock and the bus cycles ----
  clkEdge(rise, t) {
    if (rise) {
      this.rises++; this.tRise = t; this.intPrev = this.intNow; this.intNow = this.u.get(this.P.INT);
      const c = this.cur; if (!c) return;
      if (++c.T > c.len) { this.cur = null; return; }
      this.act(c, true);
    } else if (this.cur) this.act(this.cur, false);
  }
  cycle(c) {                                        // run one machine cycle from the clock rise just past; returns at the next cycle's first rise
    c.T = 1; this.cur = c; this.cycles++;
    const t0 = this.tRise;
    if (c.k === 'ID') this.u.at(t0 + this.D.addr, () => this.setA(this.lastA));
    else this.u.at(t0 + this.D.addr, () => this.setA(c.a));
    this.act(c, true);
    while (this.cur) this.adv(this.u.t + this.OSC / 4);
    this.T += Math.round((this.tRise - t0) / (4 * this.OSC));
    this.holds += Math.round((this.tRise - t0) / (4 * this.OSC)) - c.len;
    return c.val;
  }
  act(c, rise) {
    const k = c.k, T = c.T;
    if (k === 'M1' || k === 'IA') {
      const w = k === 'IA' ? 2 : 0;
      if (!rise && T === 1 && !w) { this.ctl('MREQ', 0); this.ctl('RD', 0); }
      if (!rise && T === 3 && w) this.ctl('IORQ', 0);
      if (rise && T === 3 + w) {
        if (k === 'M1') c.val = this.cpuRead(c.a);
        this.ctl('MREQ', 1); this.ctl('RD', 1); this.ctl('IORQ', 1); this.later(this.D.addr, () => this.setA(c.rf)); this.lastA = c.rf;
      }
      if (!rise && T === 3 + w) this.ctl('MREQ', 0);
      if (!rise && T === 4 + w) this.ctl('MREQ', 1);
    } else if (k === 'MR' || k === 'MW') {
      if (!rise && T === 1) { this.ctl('MREQ', 0); if (k === 'MR') this.ctl('RD', 0); else this.later(this.D.ctl, () => { this.cpuOut = c.d; this.dPins(); }); }
      if (!rise && T === 2 && k === 'MW') this.ctl('WR', 0);
      if (!rise && T === 3) {
        if (k === 'MR') c.val = this.cpuRead(c.a);
        else if (c.a >= 0x8000) this.ram[c.a - 0x4000] = c.d;           // the upper RAM takes the byte as WR rises
        this.ctl('MREQ', 1); this.ctl('RD', 1); this.ctl('WR', 1); if (k === 'MW') this.later(this.D.ctl + 10, () => { this.cpuOut = null; this.dPins(); });
        this.lastA = c.a;
      }
    } else if (k === 'IR' || k === 'IW') {
      if (rise && T === 2) { this.ctl('IORQ', 0); if (k === 'IR') this.ctl('RD', 0); else { this.ctl('WR', 0); this.later(this.D.ctl, () => { this.cpuOut = c.d; this.dPins(); }); } }
      if (!rise && T === 4) {
        if (k === 'IR') c.val = this.pins(this.DP);
        this.ctl('IORQ', 1); this.ctl('RD', 1); this.ctl('WR', 1); if (k === 'IW') this.later(this.D.ctl + 10, () => { this.cpuOut = null; this.dPins(); });
        this.lastA = c.a;
      }
    }
  }
  // cycles the core logged without calling the bus: idle T-states and the interrupt acknowledge
  flush() {
    const cy = this.cpu.cyc;
    for (; this.done < cy.length; this.done++) {
      const x = cy[this.done];
      if (x.k === 'ID') this.cycle({ k: 'ID', len: x.n });
      else if (x.k === 'IA') { this.ints++; this.cycle({ k: 'IA', len: 6, a: x.a, rf: x.rf }); }
    }
  }
  // ---- the bus as src/z80core.js calls it ----
  read(a) {
    this.flush();
    const m1 = this.m1Next || this.cpu.cyc.length === 0; this.m1Next = false;   // halted and NMI fetches come first in an instruction
    const v = m1 ? this.cycle({ k: 'M1', len: 4, a, rf: (this.cpu.i << 8) | this.cpu.r }) : this.cycle({ k: 'MR', len: 3, a });
    this.done++; return v;
  }
  write(a, v) { this.flush(); this.cycle({ k: 'MW', len: 3, a, d: v }); this.done++; }
  input(p) { this.flush(); const v = this.cycle({ k: 'IR', len: 4, a: p }); this.done++; return v; }
  output(p, v) { this.flush(); this.cycle({ k: 'IW', len: 4, a: p, d: v }); this.done++; }
  // one instruction. INT as the Z80 samples it: on the rising edge that starts the last T-state of the instruction
  step() { this.cpu.intLine = this.intPrev === 0; this.done = 0; this.cpu.step(); this.flush(); }
  run(ns) { const end = this.u.t + ns; while (this.u.t < end) this.step(); }
  key(name, down) { for (let r = 0; r < 8; r++) { const b = SPECULA_KEYS[r].indexOf(name); if (b >= 0) { this.keys[r] = down ? this.keys[r] | 1 << b : this.keys[r] & ~(1 << b); return true; } } return false; }
  // take over a machine state from the emulator (src/spectrum.js): RAM and the Z80's registers; the border is written
  // to the ULA with an OUT cycle
  adopt(m) {
    this.ram.set(m.ram);
    const s = m.cpu.snapshot(); for (const k in s) this.cpu[k] = s[k];
    this.cpu.eiDelay = false;
    this.cycle({ k: 'IW', len: 4, a: 0xFE, d: m.border | m.out });
  }
}
if (typeof module !== 'undefined') module.exports = { SpecUla, SPECULA_KEYS, SPECULA_VN };
