// ---- The closed-loop ZX81 on the synchronous ULA, clock edge by clock edge ----
// The same machine as ula/zx81ula.js, with the same rule (nothing of the ULA is modelled: the Z80 and the TV get
// everything from the ULA's pins), but made for speed and for one engine only: the synchronous design, as translate()
// or fromYosys() in ula/v2js.js gives it. There is no event queue. Time moves in periods of the design's 13 MHz clock,
// four to a T-state, and each period is: the wires settle, the Z80 or the TV reads what it needs, the clock edge,
// then whatever the Z80 changes after that edge. The Z80's data-sheet delays (30-40 ns) are shorter than one period,
// so "just after the edge" is where its outputs change; the memory answers two periods (154 ns) after it is selected.
// Edges are numbered within a machine cycle: T1 starts at edge 0, falls at 2; T2 starts at 4; and so on.
// The board is as in zx81ula.js: A0'-A8' and the data lines through resistors with the ULA winning on its side,
// INT on A6, WAIT low while NMI and HALT are both low, the ROM on ROM CS, the RAM (one block) on RAM CS.

const ZX81FAST_KEYS = [
  ['Shift', 'Z', 'X', 'C', 'V'], ['A', 'S', 'D', 'F', 'G'], ['Q', 'W', 'E', 'R', 'T'], ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'], ['P', 'O', 'I', 'U', 'Y'], ['NewLine', 'L', 'K', 'J', 'H'], ['Space', '.', 'M', 'N', 'B']
];

class Zx81Fast {
  // Z80: the CPU class of src/z80core.js; core: the ULA from translate() or fromYosys(); rom: the 8K ROM image
  constructor(Z80, core, rom, opts = {}) {
    this.M = core; this.rom = rom; this.ram = new Uint8Array(0x4000); this.ramSize = opts.ramSize || 0x4000;
    const s = this.s = core.state();
    Object.assign(s, { kbd_n: 0x1F, usa_uk: 1, tape_in: 1, mreq_n: 1, m1_n: 1, rd_n: 1, wr_n: 1, iorq_n: 1, halt_n: 1, a15: 0, a14: 0, d_in: 0xFF });
    this.keys = new Uint8Array(8);
    this.cpuA = 0; this.zD = -1;                  // the Z80's address; the byte it drives on the data lines (-1: none)
    this.mem = 0xFF; this.memQ = 0xFF;            // the memory's output now, and what it will be one period on
    this.W = 414; this.H = 312; this.fb = new Uint8Array(this.W * this.H); this.frame = new Uint8Array(this.W * this.H);
    this.x = 0; this.y = 0; this.syncLen = 0; this.frames = 0; this.onFrame = null;
    this.n = 0;                                   // clock edges so far
    this.nmiEdge = -1; this.nmiWas = 0; this.waits = 0; this.nmis = 0; this.ints = 0; this.T = 0;
    this.rec = null; this.cpu = new Z80(this); this.done = 0; this.lastA = 0xFFFF; this.tape = null;   // tape: a .p file waiting for LOAD
    do this.go(1); while (this.get('ph') !== 0);  // line the first T-state up with the ULA's clock
  }
  get(n) { this.settle(); return this.s[n]; }
  // the wires, from the pins as they stand; the ULA reads its own pins, so what it pulls low it reads low
  settle() {
    const s = this.s, M = this.M, ext = this.zD >= 0 ? this.zD : this.mem;
    s.d_in = ext & ~s.d_pull & 0xFF; s.a0_in = s.a_oe ? s.a_out & 1 : this.cpuA & 1; s.a1_in = s.a_oe ? s.a_out >> 1 & 1 : this.cpuA >> 1 & 1;
    M.comb(s);
    const d = ext & ~s.d_pull & 0xFF, a0 = s.a_oe ? s.a_out & 1 : this.cpuA & 1, a1 = s.a_oe ? s.a_out >> 1 & 1 : this.cpuA >> 1 & 1;
    if (d !== s.d_in || a0 !== s.a0_in || a1 !== s.a1_in) { s.d_in = d; s.a0_in = a0; s.a1_in = a1; M.comb(s); }
  }
  // k clock periods. Each: settle; the memory sees its selects; the TV takes a dot; NMI is noticed; then the edge.
  go(k) {
    const s = this.s, M = this.M, rom = this.rom, ram = this.ram;
    for (; k > 0; k--) {
      this.settle();
      const a = (this.cpuA & 0xFE00) | (s.a_oe ? s.a_out : this.cpuA & 0x1FF);
      const want = !s.rom_cs_n ? rom[a & 0x1FFF] : !s.ram_cs_n && s.wr_n ? ram[a & (this.ramSize - 1)] : 0xFF;
      if (s.ph & 1) this.dot(s.sync ? 0 : s.black ? 1 : 2);        // the next edge is a dot clock
      if (s.nmi_pull && !this.nmiWas) this.nmiEdge = this.n; this.nmiWas = s.nmi_pull;
      if (this.rec) this.rec(s, this);                          // a recorder, if one is fitted (the page's logic analyser)
      M.edge(s); this.n++;
      this.mem = this.memQ; this.memQ = want;
    }
  }
  dot(v) {                                        // the level on TV/TAPE for one dot: 0 sync, 1 black, 2 white
    if (v === 0) { this.syncLen++; return; }
    if (this.syncLen) {
      if (this.syncLen > 200) { this.frame.set(this.fb); this.fb.fill(0); this.y = 0; this.frames++; if (this.onFrame) this.onFrame(this.frame); }
      else if (++this.y >= this.H) this.y = 0;    // no vertical sync: the picture rolls
      this.x = 0; this.syncLen = 0;
    }
    if (this.x < this.W) this.fb[this.y * this.W + this.x++] = v;
  }
  setA(a) { this.cpuA = a; this.s.a14 = a >> 14 & 1; this.s.a15 = a >> 15 & 1; }
  dBus() { this.settle(); return this.s.d_in; }  // the data lines on the Z80's side
  // WAIT, sampled just before the falling edge of T2 (edge 6) and of each wait state; called just after edge 2
  waitT2() { for (let k = 3; ; k = 4) { this.go(k); this.settle(); if (this.s.nmi_pull && !this.s.halt_n) { this.waits++; this.T++; } else return; } }
  // ---- the Z80's machine cycles: each starts just after the edge that begins its T1 and ends the same way ----
  m1(a, halt, rf) {
    const s = this.s;
    this.setA(a); s.m1_n = 0; s.halt_n = halt ? 0 : 1; this.go(2);
    s.mreq_n = 0; s.rd_n = 0; this.waitT2();                    // just after edge 5
    this.go(2); const d = this.dBus();                          // just before edge 8, T3: the Z80 takes the opcode
    this.go(1); s.mreq_n = 1; s.rd_n = 1; s.m1_n = 1; this.setA(rf);
    this.go(2); s.mreq_n = 0;                                   // refresh
    this.go(4); s.mreq_n = 1;
    this.go(2); this.T += 4; this.lastA = rf; return d;
  }
  intack(a, rf) {
    const s = this.s; this.ints++;
    this.setA(a); s.m1_n = 0; s.halt_n = 1; this.go(10);
    s.iorq_n = 0; this.go(6);
    s.iorq_n = 1; s.m1_n = 1; this.setA(rf); this.go(2);
    s.mreq_n = 0; this.go(4);
    s.mreq_n = 1; this.go(2); this.T += 6; this.lastA = rf;
  }
  mrd(a) {
    const s = this.s;
    this.setA(a); this.go(2);
    s.mreq_n = 0; s.rd_n = 0; this.waitT2();
    this.go(4); const d = this.dBus();                          // just before edge 10, the fall of T3
    this.go(1); s.mreq_n = 1; s.rd_n = 1;
    this.go(2); this.T += 3; this.lastA = a; return d;
  }
  mwr(a, v) {
    const s = this.s;
    this.setA(a); this.go(2);
    s.mreq_n = 0; this.zD = v; this.go(4);
    s.wr_n = 0; this.go(3); this.settle();                      // just before edge 10: WR about to rise
    if (!s.ram_cs_n) this.ram[((this.cpuA & 0xFE00) | (s.a_oe ? s.a_out : this.cpuA & 0x1FF)) & (this.ramSize - 1)] = s.d_in;
    this.go(1); s.mreq_n = 1; s.wr_n = 1; this.zD = -1;
    this.go(2); this.T += 3; this.lastA = a;
  }
  io(a, v) {                                      // v undefined: a read
    const s = this.s, rd = v === undefined;
    let kb = 0x1F; for (let r = 0; r < 8; r++) if (!(a & (0x100 << r))) kb &= ~this.keys[r] & 0x1F;
    this.setA(a); s.kbd_n = kb; if (!rd) this.zD = v; this.go(4);
    s.iorq_n = 0; if (rd) s.rd_n = 0; else s.wr_n = 0;
    this.go(9); const d = this.dBus();                          // just before edge 14, the fall of T3 (after TW)
    this.go(1); s.iorq_n = 1; s.rd_n = 1; s.wr_n = 1; this.zD = -1;
    this.go(2); this.T += 4; this.lastA = a; return d;
  }
  // cycles the core logged without calling the bus: idle T-states and the interrupt acknowledge
  flush() {
    const c = this.cpu.cyc;
    for (; this.done < c.length; this.done++) { const x = c[this.done]; if (x.k === 'ID') { this.go(4 * x.n); this.T += x.n; } else if (x.k === 'IA') this.intack(x.a, x.rf); }
  }
  // ---- the bus as src/z80core.js calls it ----
  rfsh() { return this.cpu.i << 8 | this.cpu.r; }
  fetch(a) { this.flush(); const d = this.m1(a, false, this.rfsh()); this.done++; return d; }
  read(a) {       // with nothing logged yet this is the opcode read of an NMI response or of a halted Z80: an M1 cycle
    this.flush(); const d = this.cpu.cyc.length === 0 ? this.m1(a, this.cpu.halted, this.rfsh()) : this.mrd(a); this.done++; return d;
  }
  write(a, v) { this.flush(); this.mwr(a, v); this.done++; }
  input(p) { this.flush(); const d = this.io(p); this.done++; return d; }
  output(p, v) { this.flush(); this.io(p, v); this.done++; }
  // one instruction. NMI: its falling edge, if it came before the last T-state began. INT: A6, as that T-state begins.
  step() {
    const cpu = this.cpu;
    // LOAD: the tape itself is not modelled. As in the hybrid emulator, the ROM's byte reader (034Ch) is replaced:
    // the waiting .p file goes into RAM from 4009h and the ROM carries on at 0207h, which puts SLOW mode back
    if (cpu.pc === 0x034C && this.tape && !cpu.halted && this.rom[0x34C] === 0x0E && this.rom[0x207] === 0x21) {
      this.loadP(this.tape); this.tape = null; cpu.sp = (cpu.sp + 2) & 0xFFFF; cpu.pc = 0x0207;
    }
    if (this.nmiEdge >= 0 && this.nmiEdge <= this.n - 4) { cpu.nmiPending = true; this.nmiEdge = -1; this.nmis++; }
    cpu.intLine = !(this.lastA & 0x40);
    this.done = 0; cpu.step(); this.flush();
  }
  run(tStates) { const end = this.T + tStates; while (this.T < end) this.step(); }
  key(name, down) { for (let r = 0; r < 8; r++) { const b = ZX81FAST_KEYS[r].indexOf(name); if (b >= 0) { this.keys[r] = down ? this.keys[r] | 1 << b : this.keys[r] & ~(1 << b); return true; } } return false; }
  // a .p file is RAM from 4009h up to E_LINE (which it holds at 4014h)
  loadP(b) { const n = Math.min(b.length, (b[0x0B] | b[0x0C] << 8) - 0x4009, this.ramSize - 9); this.ram.set(b.subarray(0, n), 9); }
}
if (typeof module !== 'undefined') module.exports = { Zx81Fast, ZX81FAST_KEYS };
