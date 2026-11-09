// Sinclair ZX80 machine model for Z80 Bench.
// The ZX80 has no video chip: the Z80 "executes" the display file with A15 set. Discrete logic turns
// each character byte (bit 6 clear) into a NOP for the CPU and latches it; during the refresh half of
// that M1 cycle the address bus carries I:R, which with the character code and a 3-bit line counter
// addresses the font in the ROM. The ROM byte goes to a shift register and out as 8 pixels.
// Each display line ends with a HALT; /INT fires when A6 of the refresh address goes low, and the
// interrupt acknowledge advances the line counter and starts horizontal sync. Reading a port with
// A0 low starts vertical sync; any port write ends it and clears the line counter.

const ZX = {
  CPU_HZ: 3250000,          // 6.5 MHz crystal / 2
  LINE_T: 207,              // T-states per scan line as the ROM times it (64 us at 3.25 MHz is 208)
  W: 414,                   // 2 pixels per T-state across a whole line
  H: 312,                   // lines kept by the virtual TV
  HSYNC_DELAY: 13, HSYNC_LEN: 20
};
// Keyboard half-rows, selected by A8-A15 low; keys read on D0-D4 (first key = D0), active low.
const ZX_KEYS = [
  ['Shift', 'Z', 'X', 'C', 'V'], ['A', 'S', 'D', 'F', 'G'], ['Q', 'W', 'E', 'R', 'T'], ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'], ['P', 'O', 'I', 'U', 'Y'], ['NewLine', 'L', 'K', 'J', 'H'], ['Space', '.', 'M', 'N', 'B']
];
const ZX_CYC_T = { M1: 4, MR: 3, MW: 3, IR: 4, IW: 4, IA: 6 };

class ZX80 {
  constructor(rom) {
    this.rom = new Uint8Array(0x1000); if (rom) this.rom.set(rom.subarray(0, 0x1000));
    this.ram = new Uint8Array(0x4000);
    this.ramSize = 0x400;                      // 1K as supplied; 16K with the RAM pack
    this.keys = new Uint8Array(8);             // bit set = key down
    this.fb = new Uint8Array(ZX.W * ZX.H);      // TV picture being built: 1 = ink (black)
    this.front = new Uint8Array(ZX.W * ZX.H);   // last complete picture
    this.bus = {
      read: a => this.read(a), write: (a, v) => this.write(a, v),
      input: p => this.input(p), output: (p, v) => this.output(p, v),
      fetch: a => this.fetch(a)
    };
    this.cpu = new Z80(this.bus);
    this.cpu.intVector = 0xFF;
    this.reset();
  }
  reset() {
    this.cpu.reset();
    this.t = 0;                 // T-states since power-on
    this.lcntr = 0;             // 74LS393 line counter (character row 0-7)
    this.vsync = false; this.vsyncStart = 0;
    this.intLevel = false;      // /INT from A6 of the last refresh address
    this.latch = 0; this.lastChar = -1;
    this.lineStart = 0; this.line = 0; this.hsyncEnd = -1;
    this.frames = 0; this.synced = false;
    this.fb.fill(0); this.front.fill(0);
  }
  // ---- memory: A14 selects ROM or RAM; A15 is ignored by the memory (it is the video trigger) ----
  read(a) { a &= 0x7FFF; return a & 0x4000 ? this.ram[a & (this.ramSize - 1)] : this.rom[a & 0x0FFF]; }
  peek(a) { return this.read(a); }
  write(a, v) { a &= 0x7FFF; if (a & 0x4000) this.ram[a & (this.ramSize - 1)] = v; }
  // opcode fetch: above 8000h a byte with bit 6 clear is a character; the CPU is given a NOP
  fetch(a) {
    const v = this.read(a);
    if ((a & 0x8000) && !(v & 0x40)) { this.latch = v; return 0x00; }
    return v;
  }
  // ---- I/O: only A0 is decoded ----
  input(p) {
    if (p & 1) return 0xFF;
    if (!this.vsync) { this.vsync = true; this.vsyncStart = this.t; }   // a read with A0 low starts vertical sync
    let d = 0x1F;
    for (let r = 0; r < 8; r++) if (!(p & (0x100 << r))) d &= ~this.keys[r];
    return (d & 0x1F) | 0x60 | 0x80;     // D5-D6 unused (high), D7 cassette input (idle high)
  }
  output() {
    if (this.vsync) this.endVsync();
    this.lcntr = 0;                       // any port write clears the line counter
  }
  endVsync() {
    this.vsync = false;
    if (this.t - this.vsyncStart > 400) this.newFrame();   // a real vertical sync (long pulse)
  }
  key(name, down) {
    for (let r = 0; r < 8; r++) { const b = ZX_KEYS[r].indexOf(name); if (b >= 0) { this.keys[r] = down ? this.keys[r] | (1 << b) : this.keys[r] & ~(1 << b); return true; } }
    return false;
  }
  // ---- the virtual TV ----
  newFrame() {
    this.front.set(this.fb); this.fb.fill(0);
    this.line = 0; this.lineStart = this.t; this.frames++; this.synced = true;
  }
  newLine(at) {
    this.line++; this.lineStart = at;
    if (this.line >= ZX.H) { this.line = 0; this.front.set(this.fb); this.fb.fill(0); this.synced = false; }   // no vertical sync: the TV rolls
  }
  freeRun() {   // without horizontal sync the TV's own oscillator starts new lines
    while (this.t - this.lineStart > ZX.LINE_T * 1.25) this.newLine(this.lineStart + ZX.LINE_T);
  }
  plot(at, bits) {
    const x0 = (at - this.lineStart) * 2;
    if (this.line < 0 || this.line >= ZX.H || x0 < 0 || x0 + 8 > ZX.W) return;
    const o = this.line * ZX.W + x0;
    for (let b = 0; b < 8; b++) this.fb[o + b] = (bits >> (7 - b)) & 1;
  }
  // ---- per instruction: interrupts, video, sync ----
  syncInt() { this.cpu.intLine = this.intLevel; }
  afterStep(cyc) {
    const t0 = this.t; let off = 0, last = null;
    for (const c of cyc) {
      const n = ZX_CYC_T[c.k] || c.n || 0;
      if (c.k === 'M1' && !c.halt && (c.a & 0x8000) && c.d === 0x00) {
        const v = this.read(c.a);
        if (!(v & 0x40)) {   // a character: font byte from I:R with the character code and line counter
          const fa = (c.rf & 0xFE00) | ((v & 0x3F) << 3) | this.lcntr;
          let bits = fa & 0x4000 ? 0 : this.rom[fa & 0x0FFF];
          if (v & 0x80) bits ^= 0xFF;
          this.plot(t0 + off + 4, bits); this.lastChar = v;
        }
      }
      off += n; last = c;
    }
    this.t = t0 + off;
    if (this.cpu.lastEvent === 'INT') {   // acknowledge: next character row line, then horizontal sync
      this.lcntr = (this.lcntr + 1) & 7;
      this.newLine(t0 + ZX.HSYNC_DELAY + ZX.HSYNC_LEN);
    }
    this.intLevel = !!(last && last.k === 'M1' && !(last.rf & 0x40));
    this.freeRun();
  }
  step() {
    this.syncInt();
    const cyc = this.cpu.step();
    this.afterStep(cyc);
    let t = 0; for (const c of cyc) t += ZX_CYC_T[c.k] || c.n || 0;
    return t;
  }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  beam() { return { line: this.line, x: Math.max(0, (this.t - this.lineStart) * 2) }; }
}
if (typeof module !== 'undefined') module.exports = { ZX80, ZX, ZX_KEYS };
