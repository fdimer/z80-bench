// Osborne Executive (OCC2 main logic board) machine model for Z80 Bench.
// Based on the OCC2 schematic (1K00035 rev 10), the Osborne Executive Technical Manual and MAME's osbexec driver.
// Emulated: Z80A at 23.9616 MHz / 6, 128K banked DRAM, boot ROM, font RAM, scratch RAM (XRAM), video RAM with
// attribute latch, system PIA (banking, VBLANK interrupt), keyboard matrix, RTC counter, video enable.
// Floppy disks (schematic sheet 13): an FD1793 (UB17, src/wd1793.js) at ports 08h-0Bh with a 1 MHz clock, and two
// single-sided 5.25-inch drives. The system PIA's port B picks the drive and the density: PB1 low selects drive 1,
// PB2 low drive 2, and the motors run while either is selected; PB0 low is double density (DDEN*). The controller's
// READY input is tied high, its DRQ output goes nowhere (the ROM polls the status register), and INTRQ goes to CB1
// of the IEEE-488 PIA.
// Stubbed so the ROM can run: IEEE-488 PIA (nothing attached), Z80 SIO (registers only), 8253 timer.

const OSB = {
  CPU_HZ: 23961600 / 6,      // 3.9936 MHz
  LINE_T: 256,               // 768 dots per line at 12 MHz = 256 CPU T-states (64.1 us)
  LINES: 260,                // 26 text rows x 10 scan lines; rows 24-25 are vertical blanking
  VBL_LINE: 240,
  COLS: 80, ROWS: 24, ROW_STRIDE: 128, CELL_H: 10
};
OSB.FRAME_T = OSB.LINE_T * OSB.LINES;   // 66,560 T-states = 60 Hz
OSB.DRAM_HOLD_T = 2 * OSB.CPU_HZ;       // how long a dynamic RAM row keeps its data with no RAS (the datasheet promises 2 ms; real chips last far longer)

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

// Memory chips, for the pin display and for fault simulation.
// Main logic board (schematic sheets 5, 9 and 10): UD18 is the 2764 boot ROM (ROM 0); UD15 is the ROM 1 socket,
// fitted with a 6116 as scratch RAM; UC3, UC6, UA3 and UA4 are the four 6116 video RAMs (characters C000h-C7FFh
// and C800h-CFFFh, attributes D000h-D7FFh and D800h-DFFFh); UB12 and UA11 are the two 6116 font RAMs.
// The 128K of dynamic RAM is on the separate RAM board RD1140 (connector P11), which the main-board schematic does
// not show. Its schematic was reverse engineered from a real board by continuity measurement: sixteen OKI M3764-20RS
// (4164 type), U8-U15 = D0-D7 of the row selected while PRI1 (PIA PA0) is low, U17-U24 = D0-D7 of the row selected
// while PRI1 is high. A 74LS20 decodes A15-A12 all high, which keeps F000h-FFFFh in U8-U15 whatever PRI1 says.
// Neither row gets CAS during a ROM or video RAM access. U25 (74LS244, enabled by RAE*) passes the row address
// A0-A7 and U16 (enabled by CAE*) the column address A8-A15, joined output for output. The RAM address pins are not
// in straight order: RAM pin An carries CPU lines OSB_DRAM_ROW[n] (row) and OSB_DRAM_ROW[n] + 8 (column).
const OSB_DRAM_ROW = [0, 2, 1, 5, 4, 3, 6, 7];
// Each chip pin can be given a fault: 'z' (disconnected), 0 (stuck low) or 1 (stuck high).
//   address pin: that address bit is forced (a disconnected input floats high)
//   data pin: the bit reads as the forced level and is stored as the forced level (disconnected: reads and stores 1)
//   CE (or RAS, CAS on a 4164) stuck high or disconnected: the chip is never selected; reads float to 1s, writes are lost
//   CE stuck low: the chip drives the data bus during every memory read, and the bus carries the AND of the two
//   OE stuck high or disconnected: the chip never drives the bus; WE stuck high or disconnected: writes are lost
//   WE stuck low: every access is a write, so the cell is overwritten with 1s and reads float to 1s
const OSB_PINOUTS = {
  '2764': [[1, 'VPP', 'p'], [2, 'A12', 'i'], [3, 'A7', 'i'], [4, 'A6', 'i'], [5, 'A5', 'i'], [6, 'A4', 'i'], [7, 'A3', 'i'], [8, 'A2', 'i'], [9, 'A1', 'i'], [10, 'A0', 'i'], [11, 'O0', 'i'], [12, 'O1', 'i'], [13, 'O2', 'i'], [14, 'GND', 'g'],
    [15, 'O3', 'i'], [16, 'O4', 'i'], [17, 'O5', 'i'], [18, 'O6', 'i'], [19, 'O7', 'i'], [20, 'CE', 'i'], [21, 'A10', 'i'], [22, 'OE', 'i'], [23, 'A11', 'i'], [24, 'A9', 'i'], [25, 'A8', 'i'], [26, 'NC', 'c'], [27, 'PGM', 'p'], [28, 'VCC', 'p']],
  '6116': [[1, 'A7', 'i'], [2, 'A6', 'i'], [3, 'A5', 'i'], [4, 'A4', 'i'], [5, 'A3', 'i'], [6, 'A2', 'i'], [7, 'A1', 'i'], [8, 'A0', 'i'], [9, 'D0', 'i'], [10, 'D1', 'i'], [11, 'D2', 'i'], [12, 'GND', 'g'],
    [13, 'D3', 'i'], [14, 'D4', 'i'], [15, 'D5', 'i'], [16, 'D6', 'i'], [17, 'D7', 'i'], [18, 'CE', 'i'], [19, 'A10', 'i'], [20, 'OE', 'i'], [21, 'WE', 'i'], [22, 'A9', 'i'], [23, 'A8', 'i'], [24, 'VCC', 'p']],
  '4164': [[1, 'NC', 'c'], [2, 'DIN', 'i'], [3, 'WE', 'i'], [4, 'RAS', 'i'], [5, 'A0', 'i'], [6, 'A2', 'i'], [7, 'A1', 'i'], [8, 'VCC', 'p'],
    [9, 'A7', 'i'], [10, 'A5', 'i'], [11, 'A4', 'i'], [12, 'A3', 'i'], [13, 'A6', 'i'], [14, 'DOUT', 'i'], [15, 'CAS', 'i'], [16, 'GND', 'g']]
};
OSB_PINOUTS.M3764 = OSB_PINOUTS['4164'];   // OKI's 64K x 1 dynamic RAM, same pinout
class OsbChip {
  constructor(id, part, what, range, arr, base, abits, extra) {
    Object.assign(this, { id, part, what, range, arr, base, abits, mask: (1 << abits) - 1, f: {} }, extra || {});
    this.recalc();
  }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  get faulty() { for (const k in this.f) return true; return false; }
  recalc() {
    const f = this.f, lvl = k => f[k] === 'z' ? 1 : f[k], dead = k => k in f && lvl(k) === 1;
    let aAnd = 0xFFFF, aOr = 0, dAnd = 0xFF, dOr = 0;
    for (const k in f) {
      let m;
      if ((m = /^A(\d+)$/.exec(k))) { const bits = this.dram ? 0x101 << OSB_DRAM_ROW[+m[1]] : 1 << +m[1]; if (lvl(k)) aOr |= bits; else aAnd &= ~bits; }
      else if ((m = /^[DO](\d)$/.exec(k))) { if (lvl(k)) dOr |= 1 << +m[1]; else dAnd &= ~(1 << +m[1]); }
    }
    Object.assign(this, { aAnd, aOr, dAnd, dOr });
    const off = this.dram ? dead('RAS') || dead('CAS') || f.RAS === 0 || f.CAS === 0 : dead('CE');
    this.weLow = !off && f.WE === 0;
    this.noRead = off || dead('OE') || this.weLow; this.noWrite = off || dead('WE') || this.rom;
    this.always = !this.dram && f.CE === 0;            // selected all the time: fights whatever else is driving the bus
    this.dout = 'DOUT' in f ? lvl('DOUT') : -1; this.din = 'DIN' in f ? lvl('DIN') : -1;
  }
  // byte-wide chips: off is the address within the chip's part of memory
  rd(off, quiet) {
    if (this.noRead) { if (this.weLow && !quiet) this.arr[this.base + ((off & this.aAnd | this.aOr) & this.mask)] = 0xFF; return 0xFF; }
    return this.arr[this.base + ((off & this.aAnd | this.aOr) & this.mask)] & this.dAnd | this.dOr;
  }
  wr(off, v) { if (!this.noWrite) this.arr[this.base + ((off & this.aAnd | this.aOr) & this.mask)] = v & this.dAnd | this.dOr; }
}

// P1, the RAM board's 72-way connector to the main logic board (the main board calls it P11). Signals as measured on
// the RD1140 board; the power, ground and spare pins from the main board schematic (sheet 5).
// A fault on a P1 pin is on the RAM board's side of the contact: the board sees a floating input (which a TTL input
// reads as high), or a level held high or low, while the rest of the machine still sees the true signal.
//   A0-A15: the address bit the board's buffers (and its F000h decoder, for A12-A15) see is forced
//   D0-D7: the bit reads as the forced level and is stored as the forced level (disconnected: reads and stores 1)
//   PRI1: the bank select is forced (disconnected: bank 1 always, below F000h)
//   ROMDEC*, VRAMDEC*: high or disconnected, the board no longer stands aside for the ROM bank or the video RAM, so it
//     answers as well (reads carry the AND of the two, writes go to both); low, the board never answers
//   RAS, CAS*: any fault stops the strobe's edges, so no cell is read or written; without RAS nothing is refreshed either
//   RD*: write enable is RD* inverted (latched as the row address ends). High or disconnected, every access is a write,
//     so cells are overwritten with 1s and reads float to 1s; low, writes are lost
//   RAE*: high or disconnected, the row buffer never drives, so the row address floats to FFh; low, it also drives during
//     the column, and the column the RAMs see is the AND of the two address bytes. Either way the write-enable latch is
//     never clocked, so writes are lost
//   CAE*: high or disconnected, the column address floats to FFh; low, the row the RAMs see is the AND of the two bytes
//   RFSH*: high or disconnected, a refresh cycle only gives RAS to the row of chips its address happens to select, so
//     the other bank is refreshed only by being used, and forgets; low, row address bit 7 is replaced by the board's
//     refresh bit all the time, and half the cells can no longer be reached
//   MREQ*: only clocks the board's unused eighth refresh bit; a fault has no effect
const OSB_P1_PINS = (() => {
  const sig = { 2: 'ROMDEC', 3: 'MREQ', 4: 'VRAMDEC', 5: 'RFSH', 7: 'RAS', 13: 'CAS', 16: 'RD', 17: 'CAE', 19: 'RAE', 27: 'A15', 28: 'A14', 29: 'A13', 30: 'A12',
    31: 'A11', 33: 'A10', 34: 'A9', 35: 'A8', 36: 'A7', 37: 'A6', 39: 'A5', 40: 'A4', 41: 'A3', 42: 'A2', 43: 'A1', 44: 'A0',
    47: 'D7', 48: 'D6', 49: 'D5', 50: 'D4', 51: 'D3', 53: 'D2', 54: 'D1', 55: 'D0', 61: 'PRI1' };
  const gnd = new Set([1, 9, 10, 11, 12, 23, 24, 25, 26, 32, 38, 45, 46, 52, 60, 64]), nc = { 15: 'WR n/c', 21: 'CAS n/c', 62: 'PRI2 n/c' };
  const pin = n => sig[n] ? [n, sig[n], 'i'] : gnd.has(n) ? [n, n === 1 ? 'FRAME' : 'GND', 'g'] : n === 63 ? [n, '−12V', 'p'] : n >= 65 && n <= 68 ? [n, '+5V', 'p'] : n >= 69 ? [n, '+12V', 'p'] : [n, nc[n] || (n >= 56 && n <= 59 ? 'n/c' : 'spare'), 'c'];
  const odd = [], even = []; for (let n = 1; n <= 72; n += 2) { odd.push(pin(n)); even.push(pin(n + 1)); }
  return odd.concat(even.reverse());      // drawn as two columns: odd pins down the left, even pins down the right
})();
OSB_PINOUTS.P1 = OSB_P1_PINS;
class OsbP1 {
  constructor() { Object.assign(this, { id: 'P1', part: 'P1', what: 'RAM board connector: 72 ways to the main logic board', range: 'a fault here is on the RAM board\'s side of the contact', f: {}, fresh: true }); this.recalc(); }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  get faulty() { for (const k in this.f) return true; return false; }
  recalc() {
    const f = this.f, lvl = k => f[k] === 'z' ? 1 : f[k]; let aAnd = 0xFFFF, aOr = 0, dAnd = 0xFF, dOr = 0, m;
    for (const k in f) {
      if ((m = /^A(\d+)$/.exec(k))) { if (lvl(k)) aOr |= 1 << +m[1]; else aAnd &= ~(1 << +m[1]); }
      else if ((m = /^D(\d)$/.exec(k))) { if (lvl(k)) dOr |= 1 << +m[1]; else dAnd &= ~(1 << +m[1]); }
    }
    Object.assign(this, { aAnd, aOr, dAnd, dOr, fresh: true });      // fresh: the refresh bookkeeping starts again from now
  }
}

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
    this.fdc = new WD1793(OSB.CPU_HZ, { clock: 1, maxCyl: 42 });
    this.drives = [{ disk: null, cyl: 0 }, { disk: null, cyl: 0 }];      // drive 1 (A) and drive 2 (B)
    this.fdc.onIntrq = l => { if (this.conn.fdc && this.conn.pia1) this.pia1.setCB1(l ? 1 : 0); };
    this.pia0.onPB = () => this.fdcLines();
    this.bus = {
      read: a => this.read(a), write: (a, v) => this.write(a, v),
      input: p => this.input(p), output: (p, v) => this.output(p, v)
    };
    const C = (id, part, what, range, arr, base, abits, extra) => new OsbChip(id, part, what, range, arr, base, abits, extra);
    this.chips = [
      C('UD18', '2764', 'ROM 0: boot ROM (a 2764 or a pin-compatible part: an M28C64C EEPROM on the board this was checked against)', '0000h-1FFFh while the ROM bank is on', this.rom, 0, 13, { rom: true }),
      C('UD15', '6116', 'ROM 1 socket: scratch RAM', '2000h-3FFFh while the ROM bank is on (2K, repeated)', this.xram, 0, 11),
      C('UC3', '6116', 'video RAM: characters', 'C000h-C7FFh while the video bank is on', this.vchar, 0, 11),
      C('UC6', '6116', 'video RAM: characters', 'C800h-CFFFh while the video bank is on', this.vchar, 0x800, 11),
      C('UA3', '6116', 'video RAM: attributes (D7-D4)', 'D000h-D7FFh while the video bank is on', this.vattr, 0, 11),
      C('UA4', '6116', 'video RAM: attributes (D7-D4)', 'D800h-DFFFh while the video bank is on', this.vattr, 0x800, 11),
      C('UB12', '6116', 'font RAM: first 128 character shapes', 'written through 0000h-07FFh (and 1000h-17FFh) while the ROM bank is on', this.font, 0, 11),
      C('UA11', '6116', 'font RAM: alternate character shapes', 'written through 0800h-0FFFh (and 1800h-1FFFh) while the ROM bank is on', this.font, 0x800, 11)
    ];
    for (let bank = 0; bank < 2; bank++) for (let bit = 0; bit < 8; bit++)
      this.chips.push(C('U' + ((bank ? 17 : 8) + bit), 'M3764', `RAM board: data bit ${bit}, ${bank ? 'bank 1 row (PRI1 high)' : 'bank 0 row (PRI1 low)'}`, bank ? '0000h-EFFFh while bank 1 is selected' : '0000h-EFFFh while bank 0 is selected, and F000h-FFFFh always', this.dram[bank], 0, 16, { dram: true, bank, bit }));
    this.p1 = new OsbP1(); this.chips.push(this.p1);      // the RAM board's connector, last so the chip indexes stay put
    this.z80c = new BoardChip('UD22', 'Z80', 'processor', 'address, data and control lines', { label: 'UD22' }); this.chips.push(this.z80c);
    this.pinF = {}; this.netF = {}; this.heldWhy = null; this.fx = false;
    this.rasT = new Float64Array(256);                    // when each group of rows last had RAS: bank * 128 + (row & 7Fh); kept only while P1 has a fault
    this.chipById = {}; for (const c of this.chips) this.chipById[c.id] = c;
    this.acc = new Uint32Array(10);          // accesses: 0-7 the byte-wide chips in the order above, 8 and 9 the two DRAM banks
    this.faulty = false;
    this.conn = { pia0: true, pia1: true, sio: true, fdc: true };   // debug: a disconnected chip no longer sees the CPU bus
    this.cpu = new Z80(this.bus);
    // a held processor (no clock, or RESET, BUSREQ or WAIT low at its pin) does nothing for four clocks at a time
    const run = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => {
      const why = this.heldWhy; if (!why) { this.zr = false; return run(); }
      if (!this.zr && this.z80c.lv.RESET === 0) { this.cpu.reset(); this.zr = true; }
      this.cpu.lastEvent = null; return [{ k: 'ID', n: 4, held: why }];
    };
    this.reset();
  }
  reset() {
    this.pia0.reset(); this.pia1.reset(); this.sio.reset(); this.cpu.reset();
    this.pa = this.pia0.pa();               // PIA lines are inputs after reset; the bank lines float high
    this.attrLatch = 0; this.vidEna = false; this.rtc = 0;
    this.frameT = 0; this.frames = 0; this.vblank = false; this.pia0.setCB1(0);
    this.now = 0; this.lastR = 0; this.p1.fresh = true;      // T-states since reset, for the DRAM refresh bookkeeping
    this.fdc.reset(); this.fdcLines();
  }
  // ---- memory ----
  read(a) {
    if (this.fx) { const z = this.z80c.lv; if (z.MREQ === 1 || z.RD === 1) return this.z80c.busD(0xFF); return this.z80c.busD(this.readF(this.z80c.busA(a), false)); }
    if (this.faulty) return this.readF(a, false);
    const pa = this.pa;
    if (a >= 0xF000) { this.acc[8]++; return this.dram[0][a]; }
    if (pa & 0x80 && a < 0x4000) { if (a < 0x2000) { this.acc[0]++; return this.rom[a]; } this.acc[1]++; return this.xram[a & 0x7FF]; }
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      const o = a & 0xFFF; this.acc[2 + ((a >> 11) & 3)]++;
      if (a < 0xD000) { this.attrLatch = this.vattr[o]; return this.vchar[o]; }
      return this.vattr[o] | 0x0F;          // only D7-D4 are driven
    }
    this.acc[8 + (pa & 1)]++;
    return this.dram[pa & 1][a];
  }
  write(a, v) {
    if (this.fx) { const z = this.z80c.lv; if (z.MREQ === 1 || z.WR === 1) return; return this.writeF(this.z80c.busA(a), this.z80c.busD(v)); }
    if (this.faulty) return this.writeF(a, v);
    const pa = this.pa;
    if (a >= 0xF000) { this.acc[8]++; this.dram[0][a] = v; return; }
    if (pa & 0x80 && a < 0x4000) { if (a < 0x2000) { this.acc[6 + ((a >> 11) & 1)]++; this.font[a & 0xFFF] = v; } else { this.acc[1]++; this.xram[a & 0x7FF] = v; } return; }
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      const o = a & 0xFFF; this.acc[2 + ((a >> 11) & 3)]++;
      if (a < 0xD000) { this.vchar[o] = v; this.vattr[o] = this.attrLatch; }   // the latched attribute is written alongside
      else this.vattr[o] = v & 0xF0;
      return;
    }
    this.acc[8 + (pa & 1)]++;
    this.dram[pa & 1][a] = v;
  }
  // what the CPU would see, without side effects (for the memory view and disassembler)
  peek(a) {
    if (this.fx) return this.z80c.busD(this.readF(this.z80c.busA(a), true));
    if (this.faulty) return this.readF(a, true);
    const pa = this.pa;
    if (a >= 0xF000) return this.dram[0][a];
    if (pa & 0x80 && a < 0x4000) return a < 0x2000 ? this.rom[a] : this.xram[a & 0x7FF];
    if (pa & 0x40 && a >= 0xC000 && a < 0xE000) return a < 0xD000 ? this.vchar[a & 0xFFF] : this.vattr[a & 0xFFF] | 0x0F;
    return this.dram[pa & 1][a];
  }
  // ---- memory with chip faults (used only while at least one pin fault is set) ----
  // ---- lines and faults (the shared scheme in memchips.js) ----
  setFault(id, pin, v) { this.setPinFault(id, pin, v); }
  // The lines. Main logic board, from the OCC2 schematic (sheets 3 and 5; checked against an RD1137 rev 06 board): the
  // Z80 (UD22) drives ADR0-ADR15 and DATA0-DATA7 with no buffer, straight to ROM 0 (UD18), the ROM 1 socket (UD15) and
  // the RAM board connector P11. The video RAMs and the font RAMs hang off their own multiplexed lines and are not on
  // the processor's buses. RAM board, measured on an RD1140: the sixteen M3764s share the address lines from the
  // buffers U25 and U16, the write enable and CAS; each row has its own RAS (RAS0 for U8-U15, RAS1 for U17-U24). Each
  // chip's DIN and DOUT are joined, and the two chips of a data bit are wired straight to that bit's connector pin, so
  // a data line runs unbroken from the Z80 through P1 to the RAMs (a fault on the P1 pin is a bad contact in it).
  nets() {
    if (this.NETS) return this.NETS;
    const N = {}, Z = 'UD22', U = n => 'U' + n, b0 = [0, 1, 2, 3, 4, 5, 6, 7].map(b => U(8 + b)), b1 = [0, 1, 2, 3, 4, 5, 6, 7].map(b => U(17 + b)), all = b0.concat(b1);
    for (let n = 0; n < 16; n++) N['A' + n] = { label: `address line ADR${n}`, d: 0, pins: [[Z, 'A' + n], ...(n < 13 ? [['UD18', 'A' + n]] : []), ...(n < 11 ? [['UD15', 'A' + n]] : []), ['P1', 'A' + n]] };
    for (let n = 0; n < 8; n++) N['D' + n] = { label: `data line DATA${n} (to the RAM board's chips through P1)`, d: -1, pins: [[Z, 'D' + n], ['UD18', 'O' + n], ['UD15', 'D' + n], ['P1', 'D' + n], [b0[n], 'DIN'], [b0[n], 'DOUT'], [b1[n], 'DIN'], [b1[n], 'DOUT']] };
    for (let n = 0; n < 8; n++) N['RA' + n] = { label: `RAM board address line ${n} (from the buffers U25 and U16)`, d: -1, pins: all.map(c => [c, 'A' + n]) };
    N.RAS0 = { label: 'RAM board RAS line of row 0 (U8-U15)', d: -1, pins: b0.map(c => [c, 'RAS']) };
    N.RAS1 = { label: 'RAM board RAS line of row 1 (U17-U24)', d: -1, pins: b1.map(c => [c, 'RAS']) };
    N.CAS = { label: 'RAM board CAS line', d: -1, pins: all.map(c => [c, 'CAS']) };
    N.WE = { label: 'RAM board write enable line', d: -1, pins: all.map(c => [c, 'WE']) };
    return (this.NETS = N);
  }
  // Faults changed: what the Z80's pins do. An address pin at a level changes the address for everything; a data pin
  // changes every byte that passes it; MREQ, IORQ, RD or WR held high stop those cycles; CLK, RESET, BUSREQ and WAIT
  // hold the processor; INT and NMI at a level act on it.
  refault() {
    const z = this.z80c.lv;
    this.fx = this.z80c.faulty;
    this.heldWhy = 'CLK' in z ? 'no clock at the Z80\'s CLK pin' : z.RESET === 0 ? 'RESET is low at the Z80: it is held in reset' : z.BUSREQ === 0 ? 'BUSREQ is low at the Z80: it has released the bus' : z.WAIT === 0 ? 'WAIT is low at the Z80: it waits' : null;
    if (z.NMI === 0 && !this.nmiLow && this.cpu) this.cpu.nmiPending = true;
    this.nmiLow = z.NMI === 0;
  }
  held() { return this.heldWhy; }
  busA(a) { return this.fx ? this.z80c.busA(a) : a; }
  dramRead(bank, a, quiet) {
    let v = this.dram[bank][a];
    for (let b = 0; b < 8; b++) {
      const c = this.chips[8 + bank * 8 + b]; if (!c.faulty) continue;
      const o = a & c.aAnd | c.aOr; let bit;
      if (c.noRead) { bit = 1; if (c.weLow && !quiet) this.dram[bank][o] |= 1 << b; }
      else bit = c.dout >= 0 ? c.dout : (this.dram[bank][o] >> b) & 1;
      v = v & ~(1 << b) | bit << b;
    }
    return v;
  }
  dramWrite(bank, a, v) {
    const arr = this.dram[bank]; let keep = 0;
    for (let b = 0; b < 8; b++) {
      const c = this.chips[8 + bank * 8 + b]; if (!c.faulty) continue;
      keep |= 1 << b; if (c.noWrite) continue;
      const o = a & c.aAnd | c.aOr, bit = c.din >= 0 ? c.din : (v >> b) & 1;
      arr[o] = arr[o] & ~(1 << b) | bit << b;
    }
    arr[a] = arr[a] & keep | v & ~keep;
  }
  // ---- the RAM board seen through the faults on its connector P1 ----
  // What the board makes of a memory cycle at address a: which row of chips it selects (-1 none, 0 or 1), the cell they
  // address, and what its strobes and write enable do. See the notes above OSB_P1_PINS.
  ramBoard(a) {
    const P = this.p1, f = P.f, pa = this.pa, lv = (k, v) => k in f ? (f[k] === 'z' ? 1 : f[k]) : v;
    const ab = a & P.aAnd | P.aOr;
    const romdec = lv('ROMDEC', pa & 0x80 && a < 0x4000 ? 0 : 1), vramdec = lv('VRAMDEC', pa & 0x40 && a >= 0xC000 && a < 0xE000 ? 0 : 1), pri1 = lv('PRI1', pa & 1);
    const below = ab >= 0xF000 ? 0 : 1;                        // BELOW*: low for F000h up, as the board's 74LS20 sees A12-A15
    let row = ab & 0xFF, col = ab >> 8;
    if ('RAE' in f) { if (lv('RAE', 0)) row = 0xFF; else col &= ab & 0xFF; }
    if ('CAE' in f) { if (lv('CAE', 0)) col = 0xFF; else row &= ab >> 8; }
    if (f.RFSH === 0) row |= 0x80;                             // the refresh bit (it never toggles; taken as leaving the line high)
    const rae = 'RAE' in f;
    return { sel: romdec && vramdec ? (pri1 && below ? 1 : 0) : -1, below, cell: col << 8 | row, dead: 'RAS' in f || 'CAS' in f,
      weLow: !rae && 'RD' in f && lv('RD', 0) === 1, noWrite: rae || f.RD === 0 };
  }
  boardRead(b, rb, quiet) {
    if (!quiet && !('RAS' in this.p1.f)) this.rasT[b * 128 + (rb.cell & 0x7F)] = this.now;
    if (rb.dead) return 0xFF;
    if (rb.weLow) { if (!quiet) this.dramWrite(b, rb.cell, 0xFF); return 0xFF; }
    return this.dramRead(b, rb.cell, quiet) & this.p1.dAnd | this.p1.dOr;
  }
  // refresh, while P1 has a fault: which groups of rows the refresh cycles of the last instruction gave RAS to
  refreshRas() {
    const P = this.p1, f = P.f, cpu = this.cpu, r = cpu.r & 0x7F;
    if (P.fresh) { this.rasT.fill(this.now); P.fresh = false; this.lastR = r; return; }
    const n = (r - this.lastR) & 0x7F; this.lastR = r;
    if (!n || 'RAS' in f) return;
    const rf = 'RFSH' in f ? (f.RFSH === 'z' ? 1 : f.RFSH) : 0;      // RFSH* as the board sees it during a refresh cycle
    for (let k = 0; k < n; k++) {
      const rb = this.ramBoard((cpu.i << 8 | cpu.r & 0x80 | (r - k) & 0x7F) & 0xFFFF), g = rb.cell & 0x7F;
      if (!rf || rb.sel === 0 || !rb.below) this.rasT[g] = this.now;          // RAS0 EN = NAND(RFSH*, SEL0*, SEL0*, BELOW*)
      if (!rf || rb.sel === 1) this.rasT[128 + g] = this.now;                 // RAS1 EN = NAND(SEL1*, RFSH*)
    }
  }
  // once a frame, while P1 has a fault: rows that have gone too long without RAS lose their data
  decay() {
    if (this.p1.fresh) return;
    for (let g = 0; g < 256; g++) if (this.now - this.rasT[g] > OSB.DRAM_HOLD_T) {
      const arr = this.dram[g >> 7], r = g & 0x7F;
      for (let c = 0; c < 0x10000; c += 0x100) { arr[c | r] = 0xFF; arr[c | r | 0x80] = 0xFF; }
      this.rasT[g] = this.now;
    }
  }
  readF(a, quiet) {
    const pa = this.pa, ch = this.chips; let v = 0xFF, sel = -1, main = true;
    if (pa & 0x80 && a < 0x4000) { sel = a < 0x2000 ? 0 : 1; if (!quiet) this.acc[sel]++; v = ch[sel].rd(a, quiet); }
    else if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      sel = 2 + ((a >> 11) & 3); if (!quiet) this.acc[sel]++;
      if (a < 0xD000) { if (!quiet) this.attrLatch = ch[sel + 2].rd(a, true); v = ch[sel].rd(a, quiet); }
      else v = ch[sel].rd(a, quiet) | 0x0F;
    } else main = false;
    // the RAM board: normally it answers whenever the main board's chips do not; through a P1 fault it decides for itself
    if (this.p1.faulty) {
      const rb = this.ramBoard(a), b = rb.sel;
      if (b >= 0) { if (!quiet) this.acc[8 + b]++; const d = this.boardRead(b, rb, quiet); v = main ? v & d : d; }
    } else if (!main) { const b = a >= 0xF000 ? 0 : pa & 1; if (!quiet) this.acc[8 + b]++; v = this.dramRead(b, a, quiet); }
    // a chip whose CE is stuck low also drives the bus (its output enable permitting): the lines carry the AND
    for (let i = 0; i < 8; i++) { const c = ch[i]; if (!c.always || i === sel || c.noRead) continue; if (i === 0 && a & 0x2000) continue; if (i === 1 && !(a & 0x2000)) continue; v &= c.rd(a, true) | (i === 4 || i === 5 ? 0x0F : 0); }
    return v;
  }
  writeF(a, v) {
    const pa = this.pa, ch = this.chips; let main = true;
    if (pa & 0x80 && a < 0x4000) { const i = a < 0x2000 ? 6 + ((a >> 11) & 1) : 1; this.acc[i]++; ch[i].wr(a, v); }
    else if (pa & 0x40 && a >= 0xC000 && a < 0xE000) {
      const i = 2 + ((a >> 11) & 3); this.acc[i]++;
      if (a < 0xD000) { ch[i].wr(a, v); ch[i + 2].wr(a, this.attrLatch); } else ch[i].wr(a, v & 0xF0);
    } else main = false;
    if (this.p1.faulty) {
      const P = this.p1, rb = this.ramBoard(a), b = rb.sel; if (b < 0) return;
      this.acc[8 + b]++; if (!('RAS' in P.f)) this.rasT[b * 128 + (rb.cell & 0x7F)] = this.now;
      if (!rb.dead && !rb.noWrite) this.dramWrite(b, rb.cell, v & P.dAnd | P.dOr);
    } else if (!main) { const b = a >= 0xF000 ? 0 : pa & 1; this.acc[8 + b]++; this.dramWrite(b, a, v); }
  }
  // ---- I/O: 74LS138 on A2-A4, enabled when A7 = 0 (A5, A6 not decoded) ----
  input(p) {
    if (this.fx) { const z = this.z80c.lv; if (z.IORQ === 1 || z.RD === 1) return this.z80c.busD(0xFF); return this.z80c.busD(this.inputPort(this.z80c.busA(p))); }
    return this.inputPort(p);
  }
  inputPort(p) {
    const lo = p & 0xFF, r = lo & 3;
    if (lo & 0x80) return 0xFF;
    switch ((lo >> 2) & 7) {
      case 0: return this.conn.pia0 ? this.pia0.read(r) : 0xFF;
      case 1: return 0xFF;                                   // 8253 timer (stub)
      case 2: return this.conn.fdc ? this.fdc.read(r) : 0xFF;    // FD1793
      case 3: return this.conn.sio ? this.sio.read(r) : 0xFF;    // A1 = B/A, A0 = C/D
      case 4: return this.conn.pia1 ? this.pia1.read(r) : 0xFF;
      case 5: return this.kbdRead(p >> 8);
      case 6: return this.rtc;
      default: return 0xFF;
    }
  }
  output(p, v) {
    if (this.fx) { const z = this.z80c.lv; if (z.IORQ === 1 || z.WR === 1) return; p = this.z80c.busA(p); v = this.z80c.busD(v); }
    const lo = p & 0xFF, r = lo & 3;
    if (lo & 0x80) return;
    switch ((lo >> 2) & 7) {
      case 0: if (this.conn.pia0) this.pia0.write(r, v); break;
      case 2: if (this.conn.fdc) this.fdc.write(r, v); break;
      case 3: if (this.conn.sio) this.sio.write(r, v); break;
      case 4: if (this.conn.pia1) this.pia1.write(r, v); break;
      case 7: this.vidEna = true; break;                      // VID ENA flip-flop, cleared by reset
    }
  }
  // the drive select and density lines from the system PIA's port B
  fdcLines() {
    const pb = this.pia0.pb();
    this.fdc.drive = !(pb & 0x02) ? this.drives[0] : !(pb & 0x04) ? this.drives[1] : null;
    this.fdc.dden = !(pb & 0x01);
  }
  driveSelected() { return this.drives.indexOf(this.fdc.drive); }
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
    const i = this.z80c.lv.INT; this.cpu.intLine = i !== undefined ? i === 0 : this.intRequest();
    this.cpu.intVector = s ? this.sio.vector() : 0xFE;
    return s;
  }
  afterStep(cyc, sioReq) {
    if (sioReq && this.cpu.lastEvent === 'INT') this.sio.ack();
    if (this.conn.sio) for (const c of cyc) if (c.k === 'M1') this.sio.m1(c.d);
    if (this.p1.faulty) this.refreshRas();
  }
  // ---- time: raster position, VBLANK into PIA CB1, RTC counter ----
  advance(t) {
    this.frameT += t; this.now += t; this.fdc.advance(t);
    while (this.frameT >= OSB.FRAME_T) { this.frameT -= OSB.FRAME_T; this.frames++; if (this.p1.faulty) this.decay(); }
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
    const blinkOff = (this.rtc >> 4) & 1, ch = this.chips, vf = this.faulty && ch.slice(2, 8).some(c => c.faulty);
    for (let y = 0; y < OSB.ROWS * OSB.CELL_H; y++) {
      const row = (y / OSB.CELL_H) | 0, line = y % OSB.CELL_H, base = row * OSB.ROW_STRIDE;
      for (let x = 0; x < OSB.COLS; x++) {
        const o = base + x, hi = o >> 11;
        const ch = vf ? this.chips[2 + hi].rd(o, true) : this.vchar[o], at = vf ? this.chips[4 + hi].rd(o, true) : this.vattr[o];
        const fg = at & 0x80 ? 2 : 1;
        let bits = vf ? this.chips[at & 0x10 ? 7 : 6].rd((ch & 0x7F) * 16 + line, true) : this.font[(at & 0x10 ? 0x800 : 0) + (ch & 0x7F) * 16 + line];
        if (at & 0x40 && line === 9) bits = 0xFF;            // underline
        if (at & 0x20 && blinkOff) bits = 0;                  // blink
        if (ch & 0x80 && !(at & 0x10)) bits ^= 0xFF;          // reverse video
        const po = y * 640 + x * 8;
        for (let b = 0; b < 8; b++) px[po + b] = bits & (0x80 >> b) ? fg : 0;
      }
    }
  }
}
Object.assign(Osborne.prototype, BOARD_FAULTS);
if (typeof module !== 'undefined') module.exports = { Osborne, OSB, OSB_KEYS, OsbChip, OsbP1, OSB_PINOUTS };
