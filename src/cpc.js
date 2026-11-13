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
// The gate array is a chip object too (IC116), with a fault possible on every pin except CPU ADDR, CAS ADDR and 244EN.
// A fault on a pin is a fault on that chip's connection only: a broken trace to the gate array's VSYNC pin leaves the
// 8255 seeing VSYNC. So is the 6845 (IC108): faults on HSYNC, VSYNC, DE, the display address lines MA0-MA13, the row
// lines RA0-RA2 and its clock. On this board MA10, MA11, RA3, RA4 and CURSOR go nowhere that matters.
// Clocks: the 16 MHz oscillator feeds the gate array (CK16), which makes PHI (4 MHz, to the Z80) and CCLK (1 MHz, to
// the 6845 and the sound chip). Without CK16 the gate array and everything it times stop. Without PHI, or with READY
// held low, the Z80 is held (cpu.step returns one idle character of four clocks) while the video goes on. Without
// CCLK the 6845's counters stand still. With READY held high the Z80 is never made to wait: ROM reads still work,
// but a RAM access that is out of step with the gate array's RAM cycle reads what the RAM last put out, and a write
// is lost. That last part is an approximation of what the board would do.
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
  '40010': [[1, 'D5', 'i'], [2, 'D6', 'i'], [3, 'D7', 'i'], [4, 'CCLK', 'i'], [5, 'SYNC', 'i'], [6, 'VDD1', 'p'], [7, 'RESET', 'i'], [8, 'B', 'i'], [9, 'DISPEN', 'i'], [10, 'G', 'i'],
    [11, 'HSYNC', 'i'], [12, 'R', 'i'], [13, 'VSYNC', 'i'], [14, 'CPU', 'o'], [15, 'VSS1', 'g'], [16, 'CAS', 'i'], [17, 'MREQ', 'i'], [18, 'IORQ', 'i'], [19, 'PHI', 'i'], [20, 'M1', 'i'],
    [21, 'RD', 'i'], [22, 'READY', 'i'], [23, '244EN', 'o'], [24, 'CK16', 'i'], [25, 'VDD2', 'p'], [26, 'VSS2', 'g'], [27, 'ROMEN', 'i'], [28, 'A15', 'i'], [29, 'RAMRD', 'i'], [30, 'A14', 'i'],
    [31, 'CASAD', 'o'], [32, 'INT', 'i'], [33, 'MWE', 'i'], [34, 'RAS', 'i'], [35, 'D0', 'i'], [36, 'VSS3', 'g'], [37, 'D1', 'i'], [38, 'D2', 'i'], [39, 'D3', 'i'], [40, 'D4', 'i']],
  '40007': [[1, 'CPU', 'o'], [2, 'READY', 'i'], [3, 'CAS', 'i'], [4, '244EN', 'o'], [5, 'MWE', 'i'], [6, 'CASAD', 'o'], [7, 'RAS', 'i'], [8, 'CK16', 'i'], [9, 'VCC2', 'p'], [10, 'INT', 'i'],
    [11, 'SYNC', 'i'], [12, 'ROMEN', 'i'], [13, 'RAMRD', 'i'], [14, 'HSYNC', 'i'], [15, 'VSYNC', 'i'], [16, 'IORQ', 'i'], [17, 'M1', 'i'], [18, 'MREQ', 'i'], [19, 'RD', 'i'], [20, 'A15', 'i'],
    [21, 'A14', 'i'], [22, 'VCC1', 'p'], [23, 'DISPEN', 'i'], [24, 'D0', 'i'], [25, 'D1', 'i'], [26, 'D2', 'i'], [27, 'D3', 'i'], [28, 'D4', 'i'], [29, 'D5', 'i'], [30, 'D6', 'i'],
    [31, 'D7', 'i'], [32, 'B', 'i'], [33, 'VCC2', 'p'], [34, 'G', 'i'], [35, 'GND', 'g'], [36, 'R', 'i'], [37, 'RESET', 'i'], [38, 'VCC1', 'p'], [39, 'PHI', 'i'], [40, 'CCLK', 'i']]
};
// HD6845 (the same pins as the MC6845). On the CPC: CS is A14, RS is A8, R/W is A9, E comes from IORQ, CLK is the gate array's CCLK.
const CPC_CRTC_PINS = [[1, 'GND', 'g'], [2, 'RESET', 'o'], [3, 'LPSTB', 'o'], ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(n => [4 + n, 'MA' + n, 'i']), [18, 'DE', 'i'], [19, 'CURSOR', 'o'], [20, 'VCC', 'p'],
  [21, 'CLK', 'i'], [22, 'R/W', 'o'], [23, 'E', 'o'], [24, 'RS', 'o'], [25, 'CS', 'o'], ...[7, 6, 5, 4, 3, 2, 1, 0].map((d, k) => [26 + k, 'D' + d, 'o']), [34, 'RA4', 'o'], [35, 'RA3', 'o'], [36, 'RA2', 'i'], [37, 'RA1', 'i'], [38, 'RA0', 'i'], [39, 'HSYNC', 'i'], [40, 'VSYNC', 'i']];
if (typeof MEM_PINOUTS !== 'undefined') { Object.assign(MEM_PINOUTS, CPC_GA_PINS); MEM_PINOUTS.HD6845 = CPC_CRTC_PINS; for (const n of ['SYNC', 'RESET', 'CPU', 'MREQ', 'IORQ', 'M1', 'RD', '244EN', 'ROMEN', 'RAMRD', 'CASAD', 'INT', 'MWE']) MEM_ACTIVE_LOW.add(n); }
// The gate array and the 6845 as chips with pin faults, in the same shape as a MemChip so that the fault list and the pin display treat it alike.
// lv[name] is the level a faulty pin sits at (a disconnected pin floats high, except the colour outputs, which go dark); undefined = no fault.
class CPCChip {
  constructor(id, part, what, range) { Object.assign(this, { id, part, what, range, f: {} }); this.recalc(); }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  recalc() { this.lv = {}; let n = 0; for (const k in this.f) { n++; this.lv[k] = this.f[k] === 'z' ? (k === 'R' || k === 'G' || k === 'B' ? 0 : 1) : this.f[k]; } this.faulty = n > 0; this.ramDead = 'RAS' in this.f || 'CAS' in this.f;
    // 6845 address lines held at a level
    let maAnd = 0x3FFF, maOr = 0, raAnd = 31, raOr = 0, m;
    for (const k in this.lv) { if ((m = /^MA(\d+)$/.exec(k))) { if (this.lv[k]) maOr |= 1 << +m[1]; else maAnd &= ~(1 << +m[1]); } else if ((m = /^RA(\d)$/.exec(k))) { if (this.lv[k]) raOr |= 1 << +m[1]; else raAnd &= ~(1 << +m[1]); } }
    let dAnd = 0xFF, dOr = 0;
    for (const k in this.lv) if ((m = /^D(\d)$/.exec(k))) { if (this.lv[k]) dOr |= 1 << +m[1]; else dAnd &= ~(1 << +m[1]); }
    Object.assign(this, { maAnd, maOr, raAnd, raOr, dAnd, dOr });
  }
}
function cpcCrc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; }
class CPCMachine {
  constructor() {
    this.rom = new Uint8Array(0x8000).fill(0xFF); this.hasLo = false; this.hasHi = false;
    this.ram = new Uint8Array(0x10000);
    this.romChip = new MemChip('IC103', '23256', 'ROM: firmware (lower half) and BASIC (upper half)', '0000h-3FFFh and C000h-FFFFh', this.rom, 0, 15, { rom: true });
    const amap = CPC.RAM_PINS.map(([r, c]) => (1 << r) | (1 << c));
    this.ramBank = CPC.RAM_ICS.map((ic, bit) => new MemChip('IC' + ic, '4164', `RAM, data bit ${bit}`, '0000h-FFFFh', this.ram, 0, 16, { dram: true, bit, mux: 8, amap }));
    this.ga = new CPCChip('IC116', '40010', 'gate array: clocks, memory control, interrupts and video', 'port 7Fxxh (write only)');
    this.vdu = new CPCChip('IC108', 'HD6845', '6845 video controller: display address and sync timing', 'ports BCxxh-BFxxh');
    this.chips = [this.romChip, ...this.ramBank, this.ga, this.vdu];
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
    // a held processor (no clock, or READY low) does nothing for one character: the video still gets its time
    const run = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => { const why = this.held(); if (!why) return run(); this.cpu.lastEvent = null; return [{ k: 'ID', n: 4, held: why }]; };
    // the video signals of each character drawn during the last instruction, for the clock-by-clock view
    this.vlT = new Float64Array(48); this.vlF = new Int32Array(48); this.vlM = new Int32Array(48); this.vlN = 0;
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
    this.waits = 0; this.ramBus = 0xFF; this.vlN = 0;
  }
  // ---- memory ----
  // the address as the gate array sees it on its A15 and A14 pins
  gaView(a) { const g = this.ga.lv; if (g.A15 !== undefined) a = g.A15 ? a | 0x8000 : a & 0x7FFF; if (g.A14 !== undefined) a = g.A14 ? a | 0x4000 : a & 0xBFFF; return a; }
  romOn(a) { if (this.ga.faulty) a = this.gaView(a); return a < 0x4000 ? !(this.gaMode & 4) : a >= 0xC000 && !(this.gaMode & 8); }
  gaDead() { return this.ga.faulty && 'CK16' in this.ga.f; }
  // why the Z80 cannot run, or null
  held() {
    if (!this.ga.faulty) return null; const g = this.ga.lv;
    return 'CK16' in g ? 'no clock: the gate array has no 16 MHz' : 'PHI' in g ? 'no clock: PHI does not reach the Z80' : g.READY === 0 ? 'READY is low: the Z80 waits' : null;
  }
  // READY held high: is the bus cycle now being run out of step with the gate array's RAM cycle?
  outOfStep() {
    if (this.ga.lv.READY !== 1) return false;
    let t = this.t; for (const c of this.cpu.cyc) t += c.k === 'ID' ? c.n : c.k === 'IA' ? 6 : c.k === 'M1' || c.k === 'IR' || c.k === 'IW' ? 4 : 3;
    return ((t + 1) & 3) !== 1;
  }
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
    if ('CK16' in g) return 0xFF;
    const seen = g.MREQ !== 1 && g.RD !== 1;                                    // does the gate array see a memory read at all?
    const romDrive = g.ROMEN === undefined ? seen && romSel : g.ROMEN === 0, ramDrive = g.RAMRD === undefined ? seen && !romSel : g.RAMRD === 0;
    let v = 0xFF;
    if (romDrive || this.romChip.always) { if (!quiet) this.acc[0]++; const ra = this.romAddr(a); if (ra & 0x4000 ? this.hasHi : this.hasLo) v &= this.romChip.faulty ? memBankRead(this.banks[0], ra, quiet) : this.rom[ra]; }
    if (ramDrive) { if (!quiet) this.acc[1]++; if (!quiet && this.outOfStep()) v &= this.ramBus; else { const r = this.ramRead(a, quiet); if (!quiet) this.ramBus = r; v &= r; } }
    if (!quiet && g.IORQ === 0 && (this.gaView(a) & 0xC000) === 0x4000) this.gaWrite(v);   // IORQ seen low all the time: memory cycles at 4000h-7FFFh look like writes to the gate array
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
    if (this.faulty && this.ga.faulty) {
      const g = this.ga.lv;
      if (g.IORQ === 0 && (this.gaView(a) & 0xC000) === 0x4000) this.gaWrite(v);
      // no write enable: the gate array is stopped, never sees MREQ, sees RD low all the time, or the cycle is out of step
      if (this.ga.ramDead || g.MWE === 1 || 'CK16' in g || g.MREQ === 1 || g.RD === 0 || this.outOfStep()) return;
    }
    if (this.faulty) { if (this.ramBank.faulty) { memBankWrite(this.ramBank, a, v); return; } }
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
        case 1: v &= 0xFE | (this.vsOut() ? 1 : 0); break;
        case 2: v &= this.ppiC; break;
      }
    }
    return v;
  }
  output(p, v) {
    if (this.ga.faulty) {                              // the gate array through its pin faults
      const g = this.ga.lv;
      if (g.M1 === 0) { this.intCnt &= 31; this.intReq = false; }               // M1 seen low: every I/O cycle looks like an interrupt acknowledge
      if ((this.gaView(p) & 0xC000) === 0x4000 && g.IORQ !== 1 && g.M1 !== 0) this.gaWrite(v);
    } else if (!(p & 0x8000) && p & 0x4000) this.gaWrite(v);
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
  // a byte arriving at the gate array's data pins while its port is addressed
  gaWrite(v) {
    if (this.ga.faulty) { const g = this.ga.lv; if ('CK16' in g || g.RESET === 0) return; v = v & this.ga.dAnd | this.ga.dOr; }
    this.acc[2]++;
    switch (v >> 6) {
      case 0: this.gaPen = v & 0x10 ? 16 : v & 15; break;
      case 1: this.pens[this.gaPen] = v & 31; break;
      case 2: this.gaMode = v & 0x1F; if (v & 0x10) { this.intCnt = 0; this.intReq = false; } break;
    }                                                  // 3: RAM banking, not on a 464
  }
  // ---- the 6845, one character (four CPU clocks) at a time ----
  lineT() { return (this.crtc[0] + 1) * 4; }
  frameLines() { return (this.crtc[4] + 1) * (this.crtc[9] + 1) + this.crtc[5]; }
  setGateArray(part) { if (!CPC_GA_PINS[part]) return; this.ga.f = {}; this.ga.part = part; this.ga.recalc(); this.faulty = this.chips.some(c => c.faulty); }
  // the 6845's VSYNC pin, through any fault on it (it also goes to the 8255)
  vsOut() { const f = this.vdu.lv.VSYNC; return f === undefined ? this.vsync : !!f; }
  char() {
    const R = this.crtc, g = this.ga.faulty ? this.ga.lv : null, c = this.vdu.faulty ? this.vdu.lv : null;
    const stopped = (g && 'CCLK' in g) || (c && 'CLK' in c);                     // the 6845 has no clock: its counters stand still
    if (g && g.RESET === 0) { this.gaMode = 0; this.intCnt = 0; this.intReq = false; }   // the gate array held in reset
    // outputs for this character
    if (!stopped && this.hcc === R[2] && (R[3] & 15)) { this.hs = true; this.hsw = 0; }
    const de = this.vde && this.hcc < R[1]; this.de = de;
    // what the gate array sees on its three video inputs
    const hs = g && g.HSYNC !== undefined ? !!g.HSYNC : c && c.HSYNC !== undefined ? !!c.HSYNC : this.hs, vs = g && g.VSYNC !== undefined ? !!g.VSYNC : c && c.VSYNC !== undefined ? !!c.VSYNC : this.vsync,
      den = g && g.DISPEN !== undefined ? !!g.DISPEN : c && c.DE !== undefined ? !!c.DE : de;
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
        let ma = this.maRow + this.hcc, ra = this.vlc; if (c) { ma = ma & this.vdu.maAnd | this.vdu.maOr; ra = ra & this.vdu.raAnd | this.vdu.raOr; }
        const a = (ma & 0x3000) << 2 | (ra & 7) << 11 | (ma & 0x3FF) << 1, slow = this.faulty && (this.ramBank.faulty || this.ga.faulty);
        for (let half = 0, p = o; half < 2; half++) {
          let v = slow ? this.ramRead(a | half, true) : this.ram[a | half]; this.ramBus = v; if (g) v = v & this.ga.dAnd | this.ga.dOr;
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
    if (this.vlN < 48) { const n = this.vlN++; this.vlT[n] = this.vt; this.vlM[n] = (this.maRow + this.hcc) & 0x3FFF; this.vlF[n] = (this.hs ? 1 : 0) | (this.vsync ? 2 : 0) | (de ? 4 : 0) | (hs ? 8 : 0) | (vs ? 16 : 0) | (this.intReq ? 32 : 0) | this.rgb << 8 | this.vlc << 16; }
    // advance the counters
    if (stopped) return;
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
  // the video signals at a given clock of the last instruction (or now, if that clock was not recorded)
  videoAt(at) {
    let i = -1; if (at !== undefined) for (let k = 0; k < this.vlN; k++) if (this.vlT[k] <= at) i = k;
    const f = i < 0 ? (this.hs ? 1 : 0) | (this.vsync ? 2 : 0) | (this.de ? 4 : 0) | (this.gHs ? 8 : 0) | (this.gVs ? 16 : 0) | (this.intReq ? 32 : 0) | this.rgb << 8 | this.vlc << 16 : this.vlF[i];
    return { hs: f & 1, vs: f >> 1 & 1, de: f >> 2 & 1, gHs: f >> 3 & 1, gVs: f >> 4 & 1, int: f >> 5 & 1, rgb: f >> 8 & 31, ra: f >> 16 & 31, ma: i < 0 ? (this.maRow + this.hcc) & 0x3FFF : this.vlM[i] };
  }
  // where the beam is in the picture (it can be outside it)
  beam() { return { x: (this.mx - CPC.MON_X) * 16, y: this.my - CPC.MON_Y }; }
  // WAIT: READY is high one clock in four. A cycle's WAIT sample is on T2 (memory), on the automatic wait state
  // (I/O) or on the second automatic wait state (interrupt acknowledge); the cycle waits until that falls on READY.
  // Each cycle gets its number of wait states in w.
  afterStep(cyc) {
    let t = 0; const free = this.ga.lv.READY === 1;                              // READY held high: no wait states
    for (const c of cyc) {
      if (c.k === 'ID') { c.t0 = this.t + t; t += c.n; continue; }
      const off = c.k === 'IA' ? 3 : c.k === 'IR' || c.k === 'IW' ? 2 : 1, len = c.k === 'IA' ? 6 : c.k === 'M1' || off === 2 ? 4 : 3;
      const w = free ? 0 : (1 - (this.t + t + off)) & 3;
      c.w = w; c.t0 = this.t + t; this.waits += w; t += len + w;
    }
    this.t += t;
    // the gate array recognises the acknowledge by IORQ and M1 both low
    if (this.cpu.lastEvent === 'INT') { this.ints++; if (!(this.ga.faulty && (this.ga.lv.IORQ === 1 || this.ga.lv.M1 === 1))) { this.intCnt &= 31; this.intReq = false; } }
    // keep the last recorded character: the first clocks of this instruction still belong to it
    if (this.vlN) { const n = this.vlN - 1; this.vlT[0] = this.vlT[n]; this.vlF[0] = this.vlF[n]; this.vlM[0] = this.vlM[n]; this.vlN = 1; }
    if (this.gaDead()) { if (!this.dark) { this.fb.fill(20); this.dark = true; } this.rgb = 20; this.gHs = this.gVs = false; this.vt = this.t - (this.t & 3) + 4; }   // no dot clock: no picture
    else { this.dark = false; while (this.vt < this.t) { this.char(); this.vt += 4; } }
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
if (typeof module !== 'undefined') module.exports = { CPCMachine, CPCChip, CPC, CPC_GA_PINS, CPC_CRTC_PINS, cpcCrc32 };
