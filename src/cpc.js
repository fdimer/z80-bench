// Amstrad CPC 464 machine model for Z80 Bench. Step 1: the processor and the memory, with enough of the rest
// (interrupt counter, 6845 registers and frame timing, 8255, sound chip registers, keyboard matrix) for the
// firmware to start. No picture yet.
// From the CPC 464 circuit diagram:
//   IC111  Z80A, 4 MHz clock from the gate array.
//   IC116  gate array (40007, 40008 or 40010; 16 MHz crystal). It makes the CPU clock, the RAM's RAS, CAS and MWE,
//          the address selectors' CPU ADDR and CAS ADDR, ROMEN and RAMRD, READY and INT.
//          READY goes to the Z80's WAIT pin and is high for one clock in four, so every memory, I/O and
//          interrupt-acknowledge cycle is stretched until its WAIT sample falls on that clock. Instructions
//          therefore take whole microseconds: LD A,n takes 8 clocks, not 7; PUSH takes 16, not 11.
//   IC103  32K ROM (23256): firmware in the lower half, at 0000h-3FFFh; BASIC in the upper half, at C000h-FFFFh.
//          The chip's A14 is the CPU's A15. Each half can be switched off through the gate array (port 7Fxxh,
//          data bits 7-6 = 10: bit 2 set = lower ROM off, bit 3 set = upper ROM off). Writes always go to the RAM
//          underneath.
//   IC117-IC124  eight 4164 dynamic RAMs, one per data bit: IC120 D0, IC119 D1, IC118 D2, IC117 D3, IC121 D4,
//          IC122 D5, IC123 D6, IC124 D7.
//   IC109, IC104, IC113, IC105  74LS153 selectors: each RAM address pin gets a CPU row bit, a CPU column bit or
//          the matching display address bit (through 120 ohm resistors):
//            RAM pin   A0   A1   A2   A3   A4   A5   A6   A7
//            row       A2   A1   A4   A3   A6   A5   A8   A7
//            column    A9   A0   A11  A10  A13  A12  A15  A14
//   IC115  74LS244: CPU data bus to the gate array's data pins (244EN).
//   IC114  74LS373: latches the RAM's data outputs (gate on READY) and drives the CPU data bus while RAMRD is low.
// I/O is decoded from single address bits: A15 low + A14 high gate array, A14 low 6845, A13 low upper ROM number,
// A12 low printer latch, A11 low 8255, A10 low expansion.
// Interrupts: the gate array counts HSYNC pulses and asks for an interrupt every 52 (300 a second); two HSYNCs
// after VSYNC starts the count is cleared (with an interrupt if it was below 32). Acknowledging clears bit 5 of the count.
const CPC = {
  CPU_HZ: 4000000,
  ROM_LO: 0x815752DF, ROM_HI: 0x7D9A3BAC,          // CRC32 of the 464's firmware (OS_464) and BASIC 1.0
  // keyboard matrix: row (PPI port C bits 0-3, through the 74LS145), bit (sound chip port A), active low
  KEYS: [
    ['Up', 'Right', 'Down', 'F9', 'F6', 'F3', 'Enter', 'F.'],
    ['Left', 'Copy', 'F7', 'F8', 'F5', 'F1', 'F2', 'F0'],
    ['Clr', '[', 'Return', ']', 'F4', 'Shift', '\\', 'Ctrl'],
    ['^', '-', '@', 'P', ';', ':', '/', '.'],
    ['0', '9', 'O', 'I', 'L', 'K', 'M', ','],
    ['8', '7', 'U', 'Y', 'H', 'J', 'N', 'Space'],
    ['6', '5', 'R', 'T', 'G', 'F', 'B', 'V'],
    ['4', '3', 'E', 'W', 'S', 'D', 'C', 'X'],
    ['1', '2', 'Esc', 'Q', 'Tab', 'A', 'CapsLock', 'Z'],
    ['JoyUp', 'JoyDown', 'JoyLeft', 'JoyRight', 'Fire2', 'Fire1', 'Fire3', 'Del']
  ],
  // which CPU address bits each RAM address pin carries: [row, column]
  RAM_PINS: [[2, 9], [1, 0], [4, 11], [3, 10], [6, 13], [5, 12], [8, 15], [7, 14]],
  RAM_ICS: [120, 119, 118, 117, 121, 122, 123, 124]   // by data bit
};
CPC.KEYPOS = {}; CPC.KEYS.forEach((row, r) => row.forEach((k, b) => { CPC.KEYPOS[k] = [r, b]; }));
if (typeof MEM_PINOUTS !== 'undefined' && !MEM_PINOUTS['23256'])
  MEM_PINOUTS['23256'] = MEM_PINOUTS['27256'].map(p => p[0] === 1 ? [1, 'NC', 'c'] : p);
function cpcCrc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; }
class CPCMachine {
  constructor() {
    this.rom = new Uint8Array(0x8000).fill(0xFF); this.hasLo = false; this.hasHi = false;
    this.ram = new Uint8Array(0x10000);
    this.romChip = new MemChip('IC103', '23256', 'ROM: firmware (lower half) and BASIC (upper half)', '0000h-3FFFh and C000h-FFFFh', this.rom, 0, 15, { rom: true });
    const amap = CPC.RAM_PINS.map(([r, c]) => (1 << r) | (1 << c));
    this.ramBank = CPC.RAM_ICS.map((ic, bit) => new MemChip('IC' + ic, '4164', `RAM, data bit ${bit}`, '0000h-FFFFh', this.ram, 0, 16, { dram: true, bit, mux: 8, amap }));
    this.chips = [this.romChip, ...this.ramBank];
    this.banks = [[this.romChip], this.ramBank];
    this.chipById = {}; for (const c of this.chips) this.chipById[c.id] = c;
    this.faulty = false;
    this.acc = new Uint32Array(3);                    // accesses: 0 lower ROM, 1 upper ROM, 2 RAM
    this.crtc = new Uint8Array(18); this.crtcSel = 0;
    this.psg = new Uint8Array(16); this.keys = new Uint8Array(10);      // keys: bit set = key down
    this.pens = new Uint8Array(17);                   // gate array colours for pens 0-15 and the border
    this.bus = { read: a => this.read(a), write: (a, v) => this.write(a, v), input: p => this.input(p), output: (p, v) => this.output(p, v) };
    this.cpu = new Z80(this.bus); this.cpu.log = true; this.cpu.intVector = 0xFF;
    this.reset();
  }
  // a 16K or 32K image; a 16K one goes in the upper half if it starts with a ROM type byte of 80h (a BASIC ROM)
  loadRom(bytes, where) {
    if (bytes.length === 0x8000) { this.rom.set(bytes); this.hasLo = this.hasHi = true; return 'both'; }
    if (bytes.length !== 0x4000) throw new Error('A CPC ROM image is 16,384 bytes (one half) or 32,768 bytes (both halves)');
    const hi = where ? where === 'hi' : bytes[0] === 0x80;
    this.rom.set(bytes, hi ? 0x4000 : 0); if (hi) this.hasHi = true; else this.hasLo = true;
    return hi ? 'hi' : 'lo';
  }
  romCrc(hi) { return cpcCrc32(this.rom.subarray(hi ? 0x4000 : 0, hi ? 0x8000 : 0x4000)); }
  reset() {
    this.cpu.reset();
    this.t = 0; this.nextHs = 0; this.line = 0; this.frames = 0; this.vsync = false; this.vsDelay = 0;
    this.gaMode = 0; this.gaPen = 0; this.intCnt = 0; this.ints = 0; this.cpu.intLine = false;
    this.romSel = 0;
    this.ppiA = 0; this.ppiC = 0; this.ppiCtl = 0x9B; this.psgSel = 0; this.printer = 0;
    this.waits = 0;
  }
  // ---- memory ----
  romOn(a) { return a < 0x4000 ? !(this.gaMode & 4) : a >= 0xC000 && !(this.gaMode & 8); }
  romAddr(a) { return a & 0x3FFF | (a & 0x8000) >> 1; }
  mem(a, quiet) {
    const f = this.faulty; let v;
    if (this.romOn(a)) {
      const hi = a >= 0xC000; if (!quiet) this.acc[hi ? 1 : 0]++;
      if (!(hi ? this.hasHi : this.hasLo)) return 0xFF;                         // nothing in that half: the bus floats high
      return f && this.romChip.faulty ? memBankRead(this.banks[0], this.romAddr(a), quiet) : this.rom[this.romAddr(a)];
    }
    if (!quiet) this.acc[2]++;
    v = f && this.ramBank.faulty ? memBankRead(this.ramBank, a, quiet) : this.ram[a];
    // a ROM whose chip enable is stuck low drives the bus during RAM reads too: the lines carry the AND of the two
    if (f && this.romChip.always) v &= memBankRead(this.banks[0], this.romAddr(a), true);
    return v;
  }
  read(a) { return this.mem(a, false); }
  peek(a) { return this.mem(a, true); }
  peekW(a) { return this.peek(a) | this.peek((a + 1) & 0xFFFF) << 8; }
  write(a, v) { this.acc[2]++; if (this.faulty && this.ramBank.faulty) memBankWrite(this.ramBank, a, v); else this.ram[a] = v; }
  // ---- I/O ----
  psgBus() {                                           // PPI port C bits 7-6 are the sound chip's BDIR and BC1
    switch (this.ppiC >> 6) {
      case 3: this.psgSel = this.ppiA & 15; break;                               // latch address
      case 2: this.psg[this.psgSel] = this.ppiA; break;                          // write
    }
  }
  keyRow() { const r = this.ppiC & 15; return r < 10 ? ~this.keys[r] & 0xFF : 0xFF; }
  input(p) {
    let v = 0xFF;
    if (!(p & 0x4000) && (p & 0x0300) === 0x0300) v &= this.crtcSel < 18 && this.crtcSel >= 12 ? this.crtc[this.crtcSel] : 0;   // 6845 read: only R12-R17 read back
    if (!(p & 0x0800)) {
      switch (p >> 8 & 3) {
        case 0: v &= this.ppiCtl & 0x10 ? ((this.ppiC >> 6) === 1 ? (this.psgSel === 14 ? this.keyRow() : this.psg[this.psgSel]) : 0xFF) : this.ppiA; break;
        // port B: bit 0 VSYNC, bits 3-1 maker links (111 Amstrad), bit 4 50 Hz link, bit 5 expansion (high: none),
        // bit 6 printer busy (high: no printer), bit 7 cassette data in
        case 1: v &= 0xFE | (this.vsync ? 1 : 0); break;
        case 2: v &= this.ppiC; break;
      }
    }
    return v;
  }
  output(p, v) {
    if (!(p & 0x8000) && p & 0x4000) {                 // gate array
      switch (v >> 6) {
        case 0: this.gaPen = v & 0x10 ? 16 : v & 15; break;
        case 1: this.pens[this.gaPen] = v & 31; break;
        case 2: this.gaMode = v & 0x1F; if (v & 0x10) { this.intCnt = 0; this.cpu.intLine = false; } break;
      }                                                // 3: RAM banking, not on a 464
    }
    if (!(p & 0x4000)) {                               // 6845
      const f = p >> 8 & 3;
      if (f === 0) this.crtcSel = v & 31; else if (f === 1 && this.crtcSel < 16) this.crtc[this.crtcSel] = v;
    }
    if (!(p & 0x2000)) this.romSel = v;                // upper ROM number: with no expansion ROMs every number gives BASIC
    if (!(p & 0x1000)) this.printer = v;
    if (!(p & 0x0800)) {
      switch (p >> 8 & 3) {
        case 0: this.ppiA = v; this.psgBus(); break;
        case 2: this.ppiC = v; this.psgBus(); break;
        case 3:
          if (v & 0x80) { this.ppiCtl = v; this.ppiA = 0; this.ppiC = 0; }
          else { const b = 1 << (v >> 1 & 7); this.ppiC = v & 1 ? this.ppiC | b : this.ppiC & ~b; this.psgBus(); }
          break;
      }
    }
  }
  // ---- timing ----
  // 6845 frame: a line is (R0+1) characters of four clocks; HSYNC needs a width (R3 low nibble) and a position inside the line
  lineT() { return (this.crtc[0] + 1) * 4; }
  frameLines() { return (this.crtc[4] + 1) * (this.crtc[9] + 1) + this.crtc[5]; }
  hsync() {
    const R = this.crtc;
    if (++this.line >= this.frameLines()) { this.line = 0; this.frames++; }
    const vs = R[7] * (R[9] + 1), vw = R[3] >> 4 || 16, was = this.vsync;
    this.vsync = this.line >= vs && this.line < vs + vw && R[7] <= R[4];
    if (this.vsync && !was) this.vsDelay = 2;
    if (!(R[3] & 15) || R[2] > R[0]) return;           // no HSYNC pulse: the gate array has nothing to count
    this.intCnt++;
    if (this.intCnt === 52) { this.intCnt = 0; this.cpu.intLine = true; }
    if (this.vsDelay && --this.vsDelay === 0) { if (this.intCnt < 32) this.cpu.intLine = true; this.intCnt = 0; }
  }
  // WAIT: READY is high one clock in four. A cycle's WAIT sample is on T2 (memory), on the automatic wait state
  // (I/O) or on the second automatic wait state (interrupt acknowledge); the cycle waits until that falls on READY.
  // Each cycle gets its number of wait states in w.
  afterStep(cyc) {
    let t = 0;
    for (const c of cyc) {
      if (c.k === 'ID') { t += c.n; continue; }
      const off = c.k === 'IA' ? 3 : c.k === 'IR' || c.k === 'IW' ? 2 : 1, len = c.k === 'IA' ? 6 : c.k === 'M1' || off === 2 ? 4 : 3;
      const w = (1 - (this.t + t + off)) & 3;
      c.w = w; this.waits += w; t += len + w;
    }
    this.t += t;
    if (this.cpu.lastEvent === 'INT') { this.ints++; this.intCnt &= 31; this.cpu.intLine = false; }
    while (this.t >= this.nextHs) { this.nextHs += this.lineT(); this.hsync(); }
    return t;
  }
  step() { return this.afterStep(this.cpu.step()); }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  key(name, down) { const p = CPC.KEYPOS[name]; if (!p) return; if (down) this.keys[p[0]] |= 1 << p[1]; else this.keys[p[0]] &= ~(1 << p[1]); }
  // ---- the screen as text: only for the firmware's own 8 x 8 characters in ink 1 (there is no picture yet) ----
  screenText() {
    const mode = this.gaMode & 3, cols = [20, 40, 80][mode] || 80, bpc = 80 / cols, base = (this.crtc[12] & 0x30) << 10, off = ((this.crtc[12] & 3) << 8 | this.crtc[13]) * 2;
    const font = {}; for (let ch = 255; ch >= 32; ch--) font[[...this.rom.subarray(0x3800 + ch * 8, 0x3808 + ch * 8)].join()] = ch;
    const out = [];
    for (let row = 0; row < 25; row++) {
      let s = '';
      for (let col = 0; col < cols; col++) {
        const pat = [];
        for (let y = 0; y < 8; y++) {
          let bits = 0;
          for (let b = 0; b < bpc; b++) {
            const v = this.ram[base + y * 0x800 + ((off + row * 80 + col * bpc + b) & 0x7FF)];
            if (mode === 2) bits = v; else if (mode === 1) bits = bits << 4 | v >> 4; else bits = bits << 2 | (v >> 7 & 1) << 1 | v >> 6 & 1;
          }
          pat.push(bits);
        }
        const ch = font[pat.join()]; s += ch === undefined ? '?' : ch < 127 ? String.fromCharCode(ch) : ch === 164 ? '(c)' : '.';
      }
      out.push(s.replace(/\s+$/, ''));
    }
    return out;
  }
}
if (typeof module !== 'undefined') module.exports = { CPCMachine, CPC, cpcCrc32 };
