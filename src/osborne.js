// Osborne Executive (OCC2 main logic board) machine model for Z80 Bench.
// Based on the OCC2 schematic (1K00035 rev 10), the Osborne Executive Technical Manual and MAME's osbexec driver.
// Emulated: Z80A at 23.9616 MHz / 6, 128K banked DRAM, boot ROM, font RAM, scratch RAM (XRAM), video RAM with
// attribute latch, system PIA (banking, VBLANK interrupt), keyboard matrix, RTC counter, video enable.
// Stubbed so the ROM can run: IEEE-488 PIA (nothing attached), Z80 SIO (registers only), 8253 timer, MB8877 FDC.

const OSB = {
  CPU_HZ: 23961600 / 6,      // 3.9936 MHz
  LINE_T: 256,               // 768 dots per line at 12 MHz = 256 CPU T-states (64.1 us)
  LINES: 260,                // 26 text rows x 10 scan lines; rows 24-25 are vertical blanking
  VBL_LINE: 240,
  COLS: 80, ROWS: 24, ROW_STRIDE: 128, CELL_H: 10
};
OSB.FRAME_T = OSB.LINE_T * OSB.LINES;   // 66,560 T-states = 60 Hz

// Keyboard matrix: KEYMAP[row][bit] (bit 7 first). Rows are selected by A8-A15 during IN A,(14h).
const OSB_KEYS = [
  ['[', "'", 'Return', 'Shift', '', 'Ctrl', 'Tab', 'Esc'],
  ['8', '7', '6', '5', '4', '3', '2', '1'],
  ['I', 'U', 'Y', 'T', 'R', 'E', 'W', 'Q'],
  ['K', 'J', 'H', 'G', 'F', 'D', 'S', 'A'],
  [',', 'M', 'N', 'B', 'V', 'C', 'X', 'Z'],
  ['9', 'O', 'P', '.', 'Space', '0', 'Left', 'Up'],
  ['=', 'L', '\\', ';', '/', '-', 'Down', 'Right'],
  ['', '', '', '', 'AlphaLock', '', '', '']
];

const CYC_T = { M1: 4, MR: 3, MW: 3, IR: 4, IW: 4, IA: 6 };

class Osborne {
  constructor(rom) {
    this.rom = new Uint8Array(0x2000); if (rom) this.rom.set(rom.subarray(0, 0x2000));
    this.dram = [new Uint8Array(0x10000), new Uint8Array(0x10000)];
    this.xram = new Uint8Array(0x800);      // 6116 in the ROM 1 socket, 2000h-3FFFh (mirrored)
    this.font = new Uint8Array(0x1000);     // 2 x 6116, written through 0000h-1FFFh while the ROM bank is on
    this.vchar = new Uint8Array(0x1000);    // C000h-CFFFh: character codes, bit 7 = reverse video
    this.vattr = new Uint8Array(0x1000);    // D000h-DFFFh: attribute nibble in bits 7-4
    this.keys = new Uint8Array(8);          // 1 = key down
    this.alphaLock = true;
    this.pia0 = new M6821('System PIA UD12');
    this.pia1 = new M6821('IEEE-488 PIA UD8');
    this.sio = new Z80SIO();
    this.pia0.inB = 0xFF;                   // PB6 /DSR and PB7 /RI from the modem port: idle high
    for (const c of this.sio.ch) { c.cts = c.dcd = 1; c.ext.cts = c.ext.dcd = 1; }   // 1489 receivers with nothing plugged in read high (inactive)
    this.pia0.onPA = v => { this.pa = v; };
    this.bus = {
      read: a => this.read(a), write: (a, v) => this.write(a, v),
      input: p => this.input(p), output: (p, v) => this.output(p, v)
    };
    this.conn = { pia0: true, pia1: true, sio: true };   // debug: a disconnected chip no longer sees the CPU bus
    this.cpu = new Z80(this.bus);
    this.reset();
  }
  reset() {
    this.pia0.reset(); this.pia1.reset(); this.sio.reset(); this.cpu.reset();
    this.pa = this.pia0.pa();               // PIA lines are inputs after reset; the bank lines float high
    this.attrLatch = 0; this.vidEna = false; this.rtc = 0;
    this.frameT = 0; this.frames = 0; this.vblank = false; this.pia0.setCB1(0);
    this.fdcStatus = 0x80;                  // "not ready": no drive emulated yet
  }
  // ---- memory ----
  read(a) {
    const pa = this.pa;
    if (a >= 0xF000) return this.dram[0][a];
    if (pa & 0x80 && a < 0x4000) return a < 0x2000 ? this.rom[a] : this.xram[a & 0x7FF];
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      const o = a & 0xFFF;
      if (a < 0xD000) { this.attrLatch = this.vattr[o]; return this.vchar[o]; }
      return this.vattr[o] | 0x0F;          // only D7-D4 are driven
    }
    return this.dram[pa & 1][a];
  }
  write(a, v) {
    const pa = this.pa;
    if (a >= 0xF000) { this.dram[0][a] = v; return; }
    if (pa & 0x80 && a < 0x4000) { if (a < 0x2000) this.font[a & 0xFFF] = v; else this.xram[a & 0x7FF] = v; return; }
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      const o = a & 0xFFF;
      if (a < 0xD000) { this.vchar[o] = v; this.vattr[o] = this.attrLatch; }   // the latched attribute is written alongside
      else this.vattr[o] = v & 0xF0;
      return;
    }
    this.dram[pa & 1][a] = v;
  }
  // what the CPU would see, without side effects (for the memory view and disassembler)
  peek(a) {
    const pa = this.pa;
    if (a >= 0xF000) return this.dram[0][a];
    if (pa & 0x80 && a < 0x4000) return a < 0x2000 ? this.rom[a] : this.xram[a & 0x7FF];
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) return a < 0xD000 ? this.vchar[a & 0xFFF] : this.vattr[a & 0xFFF] | 0x0F;
    return this.dram[pa & 1][a];
  }
  // ---- I/O: 74LS138 on A2-A4, enabled when A7 = 0 (A5, A6 not decoded) ----
  input(p) {
    const lo = p & 0xFF, r = lo & 3;
    if (lo & 0x80) return 0xFF;
    switch ((lo >> 2) & 7) {
      case 0: return this.conn.pia0 ? this.pia0.read(r) : 0xFF;
      case 1: return 0xFF;                                   // 8253 timer (stub)
      case 2: return r === 0 ? this.fdcStatus : 0xFF;         // MB8877 (stub)
      case 3: return this.conn.sio ? this.sio.read(r) : 0xFF;    // A1 = B/A, A0 = C/D
      case 4: return this.conn.pia1 ? this.pia1.read(r) : 0xFF;
      case 5: return this.kbdRead(p >> 8);
      case 6: return this.rtc;
      default: return 0xFF;
    }
  }
  output(p, v) {
    const lo = p & 0xFF, r = lo & 3;
    if (lo & 0x80) return;
    switch ((lo >> 2) & 7) {
      case 0: if (this.conn.pia0) this.pia0.write(r, v); break;
      case 3: if (this.conn.sio) this.sio.write(r, v); break;
      case 4: if (this.conn.pia1) this.pia1.write(r, v); break;
      case 7: this.vidEna = true; break;                      // VID ENA flip-flop, cleared by reset
    }
  }
  kbdRead(rows) {
    let d = 0xFF;
    for (let r = 0; r < 8; r++) if (rows & (1 << r)) {
      d &= ~this.keys[r];
      if (r === 7 && this.alphaLock) d &= ~0x08;
    }
    return d & 0xFF;
  }
  key(name, down) {
    for (let r = 0; r < 8; r++) { const b = OSB_KEYS[r].indexOf(name); if (b >= 0 && name) { const m = 0x80 >> b; this.keys[r] = down ? this.keys[r] | m : this.keys[r] & ~m; return true; } }
    return false;
  }
  // ---- interrupts: PIA IRQs and the SIO share /INT; non-SIO acknowledge reads FEh (pull-ups, D0 forced low) ----
  intRequest() {
    const c = this.conn;
    return (c.pia0 && (this.pia0.irqA() || this.pia0.irqB())) || (c.pia1 && (this.pia1.irqA() || this.pia1.irqB())) || (c.sio && this.sio.intRequest());
  }
  syncInt() {
    const s = this.conn.sio && this.sio.intRequest();
    this.cpu.intLine = this.intRequest();
    this.cpu.intVector = s ? this.sio.vector() : 0xFE;
    return s;
  }
  afterStep(cyc, sioReq) {
    if (sioReq && this.cpu.lastEvent === 'INT') this.sio.ack();
    if (this.conn.sio) for (const c of cyc) if (c.k === 'M1') this.sio.m1(c.d);
  }
  // ---- time: raster position, VBLANK into PIA CB1, RTC counter ----
  advance(t) {
    this.frameT += t;
    while (this.frameT >= OSB.FRAME_T) { this.frameT -= OSB.FRAME_T; this.frames++; }
    const vb = this.frameT >= OSB.VBL_LINE * OSB.LINE_T;
    if (vb !== this.vblank) {
      this.vblank = vb; this.pia0.setCB1(vb ? 1 : 0);
      if (vb) this.rtc = (this.rtc + 1) & 0xFF;               // 74LS393 clocked by vertical blanking
    }
  }
  beam() { const l = Math.floor(this.frameT / OSB.LINE_T); return { line: l, dot: (this.frameT % OSB.LINE_T) * 3 }; }
  step() {
    const s = this.syncInt();
    const cyc = this.cpu.step();
    this.afterStep(cyc, s);
    let t = 0; for (const c of cyc) t += CYC_T[c.k] || c.n || 0;
    this.advance(t);
    return t;
  }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  // ---- video ----
  textRows() {
    const out = [];
    for (let r = 0; r < OSB.ROWS; r++) { let s = ''; for (let c = 0; c < OSB.COLS; c++) { const ch = this.vchar[r * OSB.ROW_STRIDE + c] & 0x7F; s += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : ' '; } out.push(s.replace(/\s+$/, '')); }
    return out;
  }
  // pixel intensities 0 (off), 1 (half), 2 (full) for a 640 x 240 frame
  renderFrame(px) {
    if (!this.vidEna) { px.fill(0); return; }
    const blinkOff = (this.rtc >> 4) & 1;
    for (let y = 0; y < OSB.ROWS * OSB.CELL_H; y++) {
      const row = (y / OSB.CELL_H) | 0, line = y % OSB.CELL_H, base = row * OSB.ROW_STRIDE;
      for (let x = 0; x < OSB.COLS; x++) {
        const ch = this.vchar[base + x], at = this.vattr[base + x];
        const fg = at & 0x80 ? 2 : 1;
        let bits = this.font[(at & 0x10 ? 0x800 : 0) + (ch & 0x7F) * 16 + line];
        if (at & 0x40 && line === 9) bits = 0xFF;            // underline
        if (at & 0x20 && blinkOff) bits = 0;                  // blink
        if (ch & 0x80 && !(at & 0x10)) bits ^= 0xFF;          // reverse video
        const o = y * 640 + x * 8;
        for (let b = 0; b < 8; b++) px[o + b] = bits & (0x80 >> b) ? fg : 0;
      }
    }
  }
}
if (typeof module !== 'undefined') module.exports = { Osborne, OSB, OSB_KEYS };
