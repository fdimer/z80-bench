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
// The ZX80 character set (codes 00h-3Fh; bit 7 gives inverse) and BASIC keywords (tokens D4h-FFh, from the ROM's table)
const ZX_CHARS = ' "▌▄▘▝▖▗▞▒▒▒£$:?()-+*/=><;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ZX_TOKENS = ['"', 'THEN', 'TO', ';', ',', ')', '(', 'NOT', '-', '+', '*', '/', 'AND', 'OR', '**', '=', '>', '<', 'LIST', 'RETURN', 'CLS', 'DIM', 'SAVE', 'FOR',
  'GO TO', 'POKE', 'INPUT', 'RANDOMISE', 'LET', '?', '?', 'NEXT', 'PRINT', '?', 'NEW', 'RUN', 'STOP', 'CONTINUE', 'IF', 'GO SUB', 'LOAD', 'CLEAR', 'REM', '?'];
const ZX_SYSVARS = [
  [0x4000, 'ERR_NR', 1, 'error code - 1 (FFh = none)'], [0x4001, 'FLAGS', 1, 'BASIC flags'], [0x4002, 'PPC', 2, 'line being run'],
  [0x4004, 'P_PTR', 2, 'next statement'], [0x4006, 'E_PPC', 2, 'current line (the > cursor)'], [0x4008, 'VARS', 2, 'variables'],
  [0x400A, 'E_LINE', 2, 'line being edited (a .o file ends here)'], [0x400C, 'D_FILE', 2, 'display file'], [0x400E, 'DF_EA', 2, 'lower screen'],
  [0x4010, 'DF_END', 2, 'end of display'], [0x4012, 'DF_SZ', 1, 'lines in the lower screen'], [0x4013, 'S_TOP', 2, 'top line listed'],
  [0x4015, 'X_PTR', 2, 'syntax error position'], [0x4017, 'OLDPPC', 2, 'line for CONTINUE'], [0x4019, 'FLAGX', 1, 'more flags'],
  [0x401A, 'T_ADDR', 2, 'syntax table pointer'], [0x401C, 'SEED', 2, 'RND seed'], [0x401E, 'FRAMES', 2, 'frame counter'],
  [0x4020, 'DEST', 2, 'variable being assigned'], [0x4022, 'RESULT', 2, 'last expression result'], [0x4024, 'S_POSN', 2, 'print position (column, line)'],
  [0x4026, 'CH_ADD', 2, 'character being interpreted']
];
function zxText(v) {
  if (v >= 0xD4) { const k = ZX_TOKENS[v - 0xD4] || '?'; return /^[A-Z]/.test(k) && k.length > 1 ? ' ' + k + ' ' : k; }
  if (v === 0x76) return '\n';
  return (v & 0x40) ? '?' : ZX_CHARS[v & 0x3F];
}
function zxDumpChar(v) {
  if (v === 0x76) return '|';
  if (v >= 0xC0) return '~';
  if (v & 0x40) return '.';
  const c = ZX_CHARS[v & 0x3F];
  return v & 0x80 ? c.toLowerCase() : c;
}
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
    this.tape = null; this.onTape = () => {};
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
    this.tapeWaiting = false;
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
  // ---- tape: the ROM's SAVE and LOAD are intercepted and the program moved as a .o file in no time ----
  // SAVE (01B6h) and LOAD (0206h) pop their return address and enter a timing loop at 01BAh / 020Ah;
  // both leave through 0283h. A .o file is RAM from 4000h up to the byte before E_LINE (400Ah).
  tapeHooked() { const r = this.rom; return r[0x1B6] === 0xD1 && r[0x1BA] === 0x3E && r[0x206] === 0xD1 && r[0x20A] === 0x3E && r[0x283] === 0x2A; }
  tapeTrap() {
    const pc = this.cpu.pc;
    if (this.tapeWaiting && (pc < 0x0203 || pc > 0x0255)) { this.tapeWaiting = false; this.onTape('idle'); }   // LOAD was broken off
    if ((pc !== 0x01BA && pc !== 0x020A) || this.cpu.halted || !this.tapeHooked()) return;
    if (pc === 0x01BA) {
      const end = this.peekW(0x400A), n = end - 0x4000;
      if (n < 0x28 || n > this.ramSize) { this.onTape('error', 'SAVE: the system variables look damaged (E_LINE ' + end.toString(16).toUpperCase() + 'h), nothing saved.'); }
      else this.onTape('save', this.ram.slice(0, n));
      this.cpu.pc = 0x0283; return;
    }
    if (!this.tape) { if (!this.tapeWaiting) { this.tapeWaiting = true; this.onTape('wait'); } return; }   // the ROM listens for a tape (SPACE is BREAK)
    const b = this.tape; this.tape = null; this.tapeWaiting = false;
    const end = b.length >= 0x0C ? b[0x0A] | b[0x0B] << 8 : 0, n = end - 0x4000;
    if (n < 0x28 || n > b.length) { this.onTape('error', `LOAD: that file is not a ZX80 program (it is ${b.length} bytes; its E_LINE says ${Math.max(0, n)}).`); return; }
    if (n > this.ramSize) { this.onTape('error', `LOAD: the program needs ${Math.ceil(n / 1024)}K of RAM; switch on the 16K RAM pack.`); return; }
    this.ram.set(b.subarray(0, n), 0);
    this.cpu.pc = 0x0283;
    this.onTape('load', n);
  }
  insertTape(bytes) { this.tape = bytes; }
  peekW(a) { return this.read(a) | this.read(a + 1) << 8; }
  // ---- RAM listing: system variables, memory areas, the BASIC program as text and a hex dump ----
  ramReport() {
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0') + 'h', h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const top = 0x4000 + this.ramSize, out = [];
    out.push(`Sinclair ZX80 RAM dump: ${this.ramSize / 1024}K at 4000h-${h4(top - 1)}`, '');
    out.push('System variables');
    for (const [a, name, w, what] of ZX_SYSVARS) out.push(`  ${h4(a)}  ${name.padEnd(7)} ${w === 2 ? h4(this.peekW(a)) : h2(this.read(a)) + 'h  '}   ${what}`);
    const vars = this.peekW(0x4008), eline = this.peekW(0x400A), dfile = this.peekW(0x400C), dfend = this.peekW(0x4010), sp = this.cpu.sp;
    out.push('', 'Memory areas');
    const area = (a, b, what) => out.push(`  ${h4(a)}-${h4(Math.max(a, b - 1))}  ${String(Math.max(0, b - a)).padStart(5)} bytes  ${what}`);
    area(0x4000, 0x4028, 'system variables'); area(0x4028, vars, 'BASIC program'); area(vars, eline, 'variables (ends with 80h)');
    area(eline, dfile, 'line being edited'); area(dfile, dfend + 1, 'display file'); area(dfend + 1, sp, 'free'); area(sp, top, 'machine stack (SP ' + h4(sp) + ')');
    out.push('', 'BASIC program');
    let a = 0x4028, lines = 0;
    while (a < vars && a < top && lines < 2000) {
      const num = this.read(a) << 8 | this.read(a + 1); let s = ''; a += 2;
      while (a < vars && this.read(a) !== 0x76) { s += zxText(this.read(a)); a++; }
      a++; lines++; out.push(String(num).padStart(6) + ' ' + s.replace(/ {2,}/g, ' ').trim());
    }
    if (!lines) out.push('  (none)');
    out.push('', 'Hex dump (characters in the ZX80 set; inverse in lower case, tokens as ~, NEWLINE as |)');
    for (let r = 0x4000; r < top; r += 16) {
      const bytes = []; let txt = '';
      for (let i = 0; i < 16; i++) { const v = this.read(r + i); bytes.push(h2(v)); txt += zxDumpChar(v); }
      out.push(`${h4(r)}  ${bytes.slice(0, 8).join(' ')}  ${bytes.slice(8).join(' ')}  ${txt}`);
    }
    return out.join('\n') + '\n';
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
    this.tapeTrap(); this.syncInt();
    const cyc = this.cpu.step();
    this.afterStep(cyc);
    let t = 0; for (const c of cyc) t += ZX_CYC_T[c.k] || c.n || 0;
    return t;
  }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  beam() { return { line: this.line, x: Math.max(0, (this.t - this.lineStart) * 2) }; }
}
if (typeof module !== 'undefined') module.exports = { ZX80, ZX, ZX_KEYS, ZX_TOKENS, zxText };
