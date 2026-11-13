// Amstrad CPC 464 machine model for Z80 Bench: the processor, the memory, the 6845 and the gate array's video,
// with enough of the rest (8255, sound chip registers, keyboard matrix) for the firmware and BASIC to run.
// No sound or cassette yet.
// From the CPC 464 circuit diagram:
//   IC111  Z80A, 4 MHz clock from the gate array.
//   IC116  gate array (40007, 40008 or 40010; 16 MHz crystal). It makes the CPU clock, the RAM's RAS, CAS and MWE,
//          the address selectors' CPU ADDR and CAS ADDR, ROMEN and RAMRD, READY and INT.
//          READY goes to the Z80's WAIT pin and is high for one clock in four, so every memory, I/O and
//          interrupt-acknowledge cycle is stretched until its WAIT sample falls on that clock. Instructions
//          therefore take whole microseconds: LD A,n takes 8 clocks, not 7; PUSH takes 16, not 11.
//   IC103  32K ROM (23256): firmware in the lower half, at 0000h-3FFFh; BASIC in the upper half, at C000h-FFFFh.
//          The chip's fifteen address pins are the CPU's A0-A14, so A14 picks the half. CS is the gate array's
//          ROMEN; OE is the expansion bus's ROMDIS, pulled low. Each half can be switched off through the gate array (port 7Fxxh,
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
// Video: the 6845 (IC108) counts characters of one microsecond (four CPU clocks), character rows and scan lines, and
// gives the display address MA0-MA13, the row line RA0-RA2, DISPEN, HSYNC and VSYNC. For every character the gate
// array reads two bytes of RAM (address: MA13-MA12, RA2-RA0, MA9-MA0, then the byte's half) and turns them into 16,
// 8 or 4 dots in the pen colours of the screen mode; outside DISPEN it sends the border colour, and black during
// the sync pulses. A new screen mode takes effect at the end of the next HSYNC. The picture is drawn the way a
// monitor would: a new line at each HSYNC, a new picture at each VSYNC, free-running when a sync is missing.
// The gate array is a chip object too (IC116), with pin faults: INT, ROMEN, RAMRD, MWE, RAS, CAS, R, G, B, SYNC and
// its HSYNC, VSYNC and DISPEN inputs.
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
  RAM_ICS: [120, 119, 118, 117, 121, 122, 123, 124],  // by data bit
  // the picture: 48 characters of 16 dots by 272 lines, starting 14 characters after HSYNC and 36 lines after VSYNC
  FW: 768, FH: 272, MON_X: 14, MON_Y: 36,
  // the gate array's 32 colour numbers as red, green, blue (three levels each)
  PALETTE: [[128, 128, 128], [128, 128, 128], [0, 255, 128], [255, 255, 128], [0, 0, 128], [255, 0, 128], [0, 128, 128], [255, 128, 128],
    [255, 0, 128], [255, 255, 128], [255, 255, 0], [255, 255, 255], [255, 0, 0], [255, 0, 255], [255, 128, 0], [255, 128, 255],
    [0, 0, 128], [0, 255, 128], [0, 255, 0], [0, 255, 255], [0, 0, 0], [0, 0, 255], [0, 128, 0], [0, 128, 255],
    [128, 0, 128], [128, 255, 128], [128, 255, 0], [128, 255, 255], [128, 0, 0], [128, 0, 255], [128, 128, 0], [128, 128, 255]],
  COLOUR_NAMES: ['white', 'white', 'sea green', 'pastel yellow', 'blue', 'purple', 'cyan', 'pink', 'purple', 'pastel yellow', 'bright yellow', 'bright white', 'bright red', 'bright magenta', 'orange', 'pastel magenta',
    'blue', 'sea green', 'bright green', 'bright cyan', 'black', 'bright blue', 'green', 'sky blue', 'magenta', 'pastel green', 'lime', 'pastel cyan', 'red', 'mauve', 'yellow', 'pastel blue']
};
CPC.KEYPOS = {}; CPC.KEYS.forEach((row, r) => row.forEach((k, b) => { CPC.KEYPOS[k] = [r, b]; }));
if (typeof MEM_PINOUTS !== 'undefined' && !MEM_PINOUTS['23256'])
  MEM_PINOUTS['23256'] = MEM_PINOUTS['27256'].map(p => p[0] === 1 ? [1, 'NC', 'c'] : p);
// The gate array's pins. Kind 'i': a fault can be put on the pin; 'o': shown only.
// 40010 (and 40008) from the pin list in the Amstrad hardware notes; 40007 from the CPC 464 circuit diagram.
const CPC_GA_PINS = {
  '40010': [[1, 'D5', 'o'], [2, 'D6', 'o'], [3, 'D7', 'o'], [4, 'CCLK', 'o'], [5, 'SYNC', 'i'], [6, 'VDD1', 'p'], [7, 'RESET', 'o'], [8, 'B', 'i'], [9, 'DISPEN', 'i'], [10, 'G', 'i'],
    [11, 'HSYNC', 'i'], [12, 'R', 'i'], [13, 'VSYNC', 'i'], [14, 'CPU', 'o'], [15, 'VSS1', 'g'], [16, 'CAS', 'i'], [17, 'MREQ', 'o'], [18, 'IORQ', 'o'], [19, 'PHI', 'o'], [20, 'M1', 'o'],
    [21, 'RD', 'o'], [22, 'READY', 'o'], [23, '244EN', 'o'], [24, 'CK16', 'o'], [25, 'VDD2', 'p'], [26, 'VSS2', 'g'], [27, 'ROMEN', 'i'], [28, 'A15', 'o'], [29, 'RAMRD', 'i'], [30, 'A14', 'o'],
    [31, 'CASAD', 'o'], [32, 'INT', 'i'], [33, 'MWE', 'i'], [34, 'RAS', 'i'], [35, 'D0', 'o'], [36, 'VSS3', 'g'], [37, 'D1', 'o'], [38, 'D2', 'o'], [39, 'D3', 'o'], [40, 'D4', 'o']],
  '40007': [[1, 'CPU', 'o'], [2, 'READY', 'o'], [3, 'CAS', 'i'], [4, '244EN', 'o'], [5, 'MWE', 'i'], [6, 'CASAD', 'o'], [7, 'RAS', 'i'], [8, 'CK16', 'o'], [9, 'VCC2', 'p'], [10, 'INT', 'i'],
    [11, 'SYNC', 'i'], [12, 'ROMEN', 'i'], [13, 'RAMRD', 'i'], [14, 'HSYNC', 'i'], [15, 'VSYNC', 'i'], [16, 'IORQ', 'o'], [17, 'M1', 'o'], [18, 'MREQ', 'o'], [19, 'RD', 'o'], [20, 'A15', 'o'],
    [21, 'A14', 'o'], [22, 'VCC1', 'p'], [23, 'DISPEN', 'i'], [24, 'D0', 'o'], [25, 'D1', 'o'], [26, 'D2', 'o'], [27, 'D3', 'o'], [28, 'D4', 'o'], [29, 'D5', 'o'], [30, 'D6', 'o'],
    [31, 'D7', 'o'], [32, 'B', 'i'], [33, 'VCC2', 'p'], [34, 'G', 'i'], [35, 'GND', 'g'], [36, 'R', 'i'], [37, 'RESET', 'o'], [38, 'VCC1', 'p'], [39, 'PHI', 'o'], [40, 'CCLK', 'o']]
};
if (typeof MEM_PINOUTS !== 'undefined') { Object.assign(MEM_PINOUTS, CPC_GA_PINS); for (const n of ['SYNC', 'RESET', 'CPU', 'MREQ', 'IORQ', 'M1', 'RD', '244EN', 'ROMEN', 'RAMRD', 'CASAD', 'INT', 'MWE']) MEM_ACTIVE_LOW.add(n); }
// The gate array as a chip with pin faults, in the same shape as a MemChip so that the fault list and the pin display treat it alike.
// lv[name] is the level a faulty pin sits at (a disconnected pin floats high, except the colour outputs, which go dark); undefined = no fault.
class CPCGateArray {
  constructor(part) { Object.assign(this, { id: 'IC116', part, what: 'gate array: clocks, memory control, interrupts and video', range: 'port 7Fxxh (write only)', f: {}, lv: {}, faulty: false }); }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  recalc() { this.lv = {}; let n = 0; for (const k in this.f) { n++; this.lv[k] = this.f[k] === 'z' ? (k === 'R' || k === 'G' || k === 'B' ? 0 : 1) : this.f[k]; } this.faulty = n > 0; this.ramDead = 'RAS' in this.f || 'CAS' in this.f; }
}
function cpcCrc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; }
class CPCMachine {
  constructor() {
    this.rom = new Uint8Array(0x8000).fill(0xFF); this.hasLo = false; this.hasHi = false;
    this.ram = new Uint8Array(0x10000);
    this.romChip = new MemChip('IC103', '23256', 'ROM: firmware (lower half) and BASIC (upper half)', '0000h-3FFFh and C000h-FFFFh', this.rom, 0, 15, { rom: true });
    const amap = CPC.RAM_PINS.map(([r, c]) => (1 << r) | (1 << c));
    this.ramBank = CPC.RAM_ICS.map((ic, bit) => new MemChip('IC' + ic, '4164', `RAM, data bit ${bit}`, '0000h-FFFFh', this.ram, 0, 16, { dram: true, bit, mux: 8, amap }));
    this.ga = new CPCGateArray('40010');
    this.chips = [this.romChip, ...this.ramBank, this.ga];
    this.banks = [[this.romChip], this.ramBank];
    this.chipById = {}; for (const c of this.chips) this.chipById[c.id] = c;
    this.faulty = false;
    this.acc = new Uint32Array(3);                    // accesses: 0 ROM, 1 RAM, 2 writes to the gate array
    this.crtc = new Uint8Array(18); this.crtcSel = 0;
    this.psg = new Uint8Array(16); this.keys = new Uint8Array(10);      // keys: bit set = key down
    this.pens = new Uint8Array(17);                   // gate array colours for pens 0-15 and the border
    this.fb = new Uint8Array(CPC.FW * CPC.FH).fill(20);   // the picture, as gate array colour numbers
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
    this.t = 0; this.vt = 0; this.line = 0; this.frames = 0; this.vsync = false; this.vsDelay = 0;
    // 6845 counters: character in the line, character row, scan line in the row, the row's first display address
    this.hcc = 0; this.vcc = 0; this.vlc = 0; this.adj = -1; this.maRow = 0; this.vde = true; this.hs = false; this.hsw = 0; this.vsw = 0; this.de = false;
    // gate array video and the monitor's beam
    this.vmode = 0; this.gHs = false; this.gVs = false; this.mx = 0; this.my = 0; this.pictures = 0; this.rgb = 20;
    this.gaMode = 0; this.gaPen = 0; this.intCnt = 0; this.ints = 0; this.intReq = false; this.cpu.intLine = false;
    this.romSel = 0;
    this.ppiA = 0; this.ppiC = 0; this.ppiCtl = 0x9B; this.psgSel = 0; this.printer = 0;
    this.waits = 0;
  }
  // ---- memory ----
  romOn(a) { return a < 0x4000 ? !(this.gaMode & 4) : a >= 0xC000 && !(this.gaMode & 8); }
  romAddr(a) { return a & 0x7FFF; }
  mem(a, quiet) {
    const f = this.faulty, g = f && this.ga.faulty ? this.ga.lv : null, romSel = this.romOn(a);
    if (!g) {
      if (romSel) {
        const hi = a >= 0xC000; if (!quiet) this.acc[0]++;
        if (!(hi ? this.hasHi : this.hasLo)) return 0xFF;                         // nothing in that half: the bus floats high
        return f && this.romChip.faulty ? memBankRead(this.banks[0], this.romAddr(a), quiet) : this.rom[this.romAddr(a)];
      }
      if (!quiet) this.acc[1]++;
      let v = f && this.ramBank.faulty ? memBankRead(this.ramBank, a, quiet) : this.ram[a];
      // a ROM whose chip enable is stuck low drives the bus during RAM reads too: the lines carry the AND of the two
      if (f && this.romChip.always) v &= memBankRead(this.banks[0], this.romAddr(a), true);
      return v;
    }
    // with a fault on the gate array's ROMEN or RAMRD the ROM and the RAM latch can both drive the bus (the lines
    // carry the AND of the two) or neither (the bus floats high)
    const romDrive = g.ROMEN === undefined ? romSel : g.ROMEN === 0, ramDrive = g.RAMRD === undefined ? !romSel : g.RAMRD === 0;
    let v = 0xFF;
    if (romDrive || this.romChip.always) { if (!quiet) this.acc[0]++; const ra = this.romAddr(a); if (ra & 0x4000 ? this.hasHi : this.hasLo) v &= this.romChip.faulty ? memBankRead(this.banks[0], ra, quiet) : this.rom[ra]; }
    if (ramDrive) { if (!quiet) this.acc[1]++; v &= this.ramRead(a, quiet); }
    return v;
  }
  // the RAM's data outputs for an address, through any chip faults; with RAS or CAS missing the chips never answer
  ramRead(a, quiet) {
    if (this.ga.faulty) { if (this.ga.ramDead) return 0xFF; if (this.ga.lv.MWE === 0) { if (!quiet) this.ram[a] = 0xFF; return 0xFF; } }   // write enable held low: every access is a write
    return this.ramBank.faulty ? memBankRead(this.ramBank, a, quiet) : this.ram[a];
  }
  read(a) { return this.mem(a, false); }
  peek(a) { return this.mem(a, true); }
  peekW(a) { return this.peek(a) | this.peek((a + 1) & 0xFFFF) << 8; }
  write(a, v) {
    this.acc[1]++;
    if (this.faulty) { if (this.ga.faulty && (this.ga.ramDead || this.ga.lv.MWE === 1)) return; if (this.ramBank.faulty) { memBankWrite(this.ramBank, a, v); return; } }
    this.ram[a] = v;
  }
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
      this.acc[2]++;
      switch (v >> 6) {
        case 0: this.gaPen = v & 0x10 ? 16 : v & 15; break;
        case 1: this.pens[this.gaPen] = v & 31; break;
        case 2: this.gaMode = v & 0x1F; if (v & 0x10) { this.intCnt = 0; this.intReq = false; } break;
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
  // ---- the 6845, one character (four CPU clocks) at a time ----
  lineT() { return (this.crtc[0] + 1) * 4; }
  frameLines() { return (this.crtc[4] + 1) * (this.crtc[9] + 1) + this.crtc[5]; }
  setGateArray(part) { if (!CPC_GA_PINS[part]) return; this.ga.f = {}; this.ga.part = part; this.ga.recalc(); this.faulty = this.chips.some(c => c.faulty); }
  char() {
    const R = this.crtc, g = this.ga.faulty ? this.ga.lv : null;
    // outputs for this character
    if (this.hcc === R[2] && (R[3] & 15)) { this.hs = true; this.hsw = 0; }
    const de = this.vde && this.hcc < R[1]; this.de = de;
    // what the gate array sees on its three video inputs
    const hs = g && g.HSYNC !== undefined ? !!g.HSYNC : this.hs, vs = g && g.VSYNC !== undefined ? !!g.VSYNC : this.vsync, den = g && g.DISPEN !== undefined ? !!g.DISPEN : de;
    if (hs && !this.gHs) this.monLine(g);                                        // HSYNC starts: the monitor flies back
    if (!hs && this.gHs) {                                                       // HSYNC ends: count it, take the new screen mode
      this.vmode = this.gaMode & 3;
      this.intCnt++;
      if (this.intCnt === 52) { this.intCnt = 0; this.intReq = true; }
      if (this.vsDelay && --this.vsDelay === 0) { if (this.intCnt < 32) this.intReq = true; this.intCnt = 0; }
    }
    if (vs && !this.gVs) { this.vsDelay = 2; if (!(g && g.SYNC !== undefined) && this.my > 200) { this.my = 0; this.pictures++; } }
    this.gHs = hs; this.gVs = vs;
    // the dots
    const x = (this.mx - CPC.MON_X) * 16, y = this.my - CPC.MON_Y;
    if (x >= 0 && x < CPC.FW && y >= 0 && y < CPC.FH) {
      const fb = this.fb, o = y * CPC.FW + x, pens = this.pens;
      if (hs || vs) { fb.fill(20, o, o + 16); this.rgb = 20; }
      else if (!den) { fb.fill(pens[16], o, o + 16); this.rgb = pens[16]; }
      else {
        const ma = this.maRow + this.hcc, a = (ma & 0x3000) << 2 | (this.vlc & 7) << 11 | (ma & 0x3FF) << 1, slow = this.faulty && (this.ramBank.faulty || this.ga.faulty);
        for (let half = 0, p = o; half < 2; half++) {
          const v = slow ? this.ramRead(a | half, true) : this.ram[a | half];
          if (this.vmode === 1) for (let i = 0; i < 4; i++) { const c = pens[v >> (7 - i) & 1 | (v >> (3 - i) & 1) << 1]; fb[p++] = c; fb[p++] = c; }
          else if (this.vmode === 2) for (let i = 7; i >= 0; i--) fb[p++] = pens[v >> i & 1];
          else {
            let p0 = v >> 7 & 1 | (v >> 3 & 1) << 1, p1 = v >> 6 & 1 | (v >> 2 & 1) << 1;
            if (this.vmode === 0) { p0 |= (v >> 5 & 1) << 2 | (v >> 1 & 1) << 3; p1 |= (v >> 4 & 1) << 2 | (v & 1) << 3; }
            fb.fill(pens[p0], p, p + 4); fb.fill(pens[p1], p + 4, p + 8); p += 8;
          }
        }
        this.rgb = fb[o + 15];
      }
    } else this.rgb = hs || vs ? 20 : den ? this.pens[0] : this.pens[16];
    if (++this.mx >= 72) this.monLine(g);                                        // no HSYNC: the monitor's own line rate, a little slow
    // advance the counters
    if (this.hs && ++this.hsw >= (R[3] & 15)) this.hs = false;
    if (this.hcc >= R[0]) { this.hcc = 0; this.endLine(R); } else this.hcc++;
  }
  monLine(g) { if (g && g.SYNC !== undefined && this.mx < 72) return; if (this.mx < 24) return; this.mx = 0; if (++this.my >= 340) { this.my = 0; this.pictures++; } }
  endLine(R) {
    this.line++;
    if (this.vsync && ++this.vsw >= (R[3] >> 4 || 16)) this.vsync = false;
    let row = false;
    if (this.adj >= 0) { this.vlc = (this.vlc + 1) & 31; if (++this.adj >= R[5]) this.newFrame(R), row = true; }
    else if (this.vlc === R[9]) {
      this.vlc = 0;
      if (this.vcc === R[4]) { if (R[5]) this.adj = 0; else this.newFrame(R); }
      else { this.vcc = (this.vcc + 1) & 127; this.maRow = (this.maRow + R[1]) & 0x3FFF; }
      row = true;
    } else this.vlc = (this.vlc + 1) & 31;
    if (row && this.adj < 0) {
      if (this.vcc === R[6]) this.vde = false;
      if (this.vcc === R[7]) { this.vsync = true; this.vsw = 0; }
    }
  }
  newFrame(R) { this.adj = -1; this.vcc = 0; this.vlc = 0; this.line = 0; this.frames++; this.vde = true; this.maRow = (R[12] & 0x3F) << 8 | R[13]; }
  // where the beam is in the picture (it can be outside it)
  beam() { return { x: (this.mx - CPC.MON_X) * 16, y: this.my - CPC.MON_Y }; }
  // WAIT: READY is high one clock in four. A cycle's WAIT sample is on T2 (memory), on the automatic wait state
  // (I/O) or on the second automatic wait state (interrupt acknowledge); the cycle waits until that falls on READY.
  // Each cycle gets its number of wait states in w.
  afterStep(cyc) {
    let t = 0;
    for (const c of cyc) {
      if (c.k === 'ID') { c.t0 = this.t + t; t += c.n; continue; }
      const off = c.k === 'IA' ? 3 : c.k === 'IR' || c.k === 'IW' ? 2 : 1, len = c.k === 'IA' ? 6 : c.k === 'M1' || off === 2 ? 4 : 3;
      const w = (1 - (this.t + t + off)) & 3;
      c.w = w; c.t0 = this.t + t; this.waits += w; t += len + w;
    }
    this.t += t;
    if (this.cpu.lastEvent === 'INT') { this.ints++; this.intCnt &= 31; this.intReq = false; }
    while (this.vt + 4 <= this.t) { this.vt += 4; this.char(); }
    return t;
  }
  preStep() {}
  intOut() { const f = this.ga.lv.INT; return f === undefined ? this.intReq : f === 0; }   // what the Z80 sees on its INT pin
  syncInt() { this.cpu.intLine = this.intOut(); }
  step() { this.syncInt(); return this.afterStep(this.cpu.step()); }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  key(name, down) { const p = CPC.KEYPOS[name]; if (!p) return; if (down) this.keys[p[0]] |= 1 << p[1]; else this.keys[p[0]] &= ~(1 << p[1]); }
  // ---- the screen memory as text: the firmware's own 8 x 8 characters in ink 1 ----
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
if (typeof module !== 'undefined') module.exports = { CPCMachine, CPCGateArray, CPC, CPC_GA_PINS, cpcCrc32 };
