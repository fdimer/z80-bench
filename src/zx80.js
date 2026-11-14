// Sinclair ZX80 / ZX81 machine model for Z80 Bench.
// Three machines share this class (setMachine): the ZX80 with its 4K ROM, the ZX80 fitted with the 8K ROM
// (Sinclair's upgrade: ZX81 BASIC, FAST mode only) and the ZX81. The ZX81's ULA adds an NMI generator that
// fires on every horizontal sync (OUT to FEh turns it on, OUT to FDh off), a free-running sync counter that is
// re-phased by each interrupt acknowledge, and /WAIT when an NMI meets a HALT, so the display starts on time.
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
  HSYNC_DELAY: 13, HSYNC_LEN: 20,
  // ZX81: from the gate-level 2C210 (ula/), driven by this emulator's bus cycles: the line counter restarts on the
  // interrupt acknowledge and its sync (counts 16-31) begins 20 T-states after the acknowledge cycle starts, for 16
  ULA_HSYNC_DELAY: 20, ULA_HSYNC_LEN: 16
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
// ZX81 character set and keywords (tokens C0h-FFh from the ROM's table at 0111h; 40h-42h are RND, INKEY$, PI)
const ZX81_CHARS = ' ▘▝▀▖▌▞▛▒▒▒"£$:?()><=+-*/;,.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ZX81_TOKENS = ['""', 'AT', 'TAB', '?', 'CODE', 'VAL', 'LEN', 'SIN', 'COS', 'TAN', 'ASN', 'ACS', 'ATN', 'LN', 'EXP', 'INT', 'SQR', 'SGN', 'ABS', 'PEEK', 'USR',
  'STR$', 'CHR$', 'NOT', '**', 'OR', 'AND', '<=', '>=', '<>', 'THEN', 'TO', 'STEP', 'LPRINT', 'LLIST', 'STOP', 'SLOW', 'FAST', 'NEW', 'SCROLL', 'CONT', 'DIM', 'REM',
  'FOR', 'GOTO', 'GOSUB', 'INPUT', 'LOAD', 'LIST', 'LET', 'PAUSE', 'NEXT', 'POKE', 'PRINT', 'PLOT', 'RUN', 'SAVE', 'RAND', 'IF', 'CLS', 'UNPLOT', 'CLEAR', 'RETURN', 'COPY'];
const ZX81_SYSVARS = [
  [0x4000, 'ERR_NR', 1, 'report code - 1 (FFh = OK)'], [0x4001, 'FLAGS', 1, 'BASIC flags'], [0x4002, 'ERR_SP', 2, 'error return on the stack'],
  [0x4004, 'RAMTOP', 2, 'first byte above BASIC'], [0x4006, 'MODE', 1, 'cursor mode (K, L, F, G)'], [0x4007, 'PPC', 2, 'line being run'],
  [0x4009, 'VERSN', 1, '0 = ZX81 (first byte of a .p file)'], [0x400A, 'E_PPC', 2, 'current line (the > cursor)'], [0x400C, 'D_FILE', 2, 'display file'],
  [0x400E, 'DF_CC', 2, 'print position in the display file'], [0x4010, 'VARS', 2, 'variables'], [0x4012, 'DEST', 2, 'variable being assigned'],
  [0x4014, 'E_LINE', 2, 'line being edited (a .p file ends here)'], [0x4016, 'CH_ADD', 2, 'character being interpreted'], [0x4018, 'X_PTR', 2, 'syntax error position'],
  [0x401A, 'STKBOT', 2, 'calculator stack bottom'], [0x401C, 'STKEND', 2, 'calculator stack end'], [0x401E, 'BERG', 1, 'calculator b register'],
  [0x401F, 'MEM', 2, 'calculator memory'], [0x4022, 'DF_SZ', 1, 'lines in the lower screen'], [0x4023, 'S_TOP', 2, 'top line listed'],
  [0x4025, 'LAST_K', 2, 'last key pressed'], [0x4027, 'DB_ST', 1, 'debounce'], [0x4028, 'MARGIN', 1, 'blank lines above/below the picture (55 = 50 Hz)'],
  [0x4029, 'NXTLIN', 2, 'next line to run'], [0x402B, 'OLDPPC', 2, 'line for CONT'], [0x402D, 'FLAGX', 1, 'more flags'], [0x402E, 'STRLEN', 2, 'string length'],
  [0x4030, 'T_ADDR', 2, 'syntax table pointer'], [0x4032, 'SEED', 2, 'RND seed'], [0x4034, 'FRAMES', 2, 'frame counter (bit 15 set when not in PAUSE)'],
  [0x4036, 'COORDS', 2, 'last PLOT position'], [0x4038, 'PR_CC', 1, 'printer position'], [0x4039, 'S_POSN', 2, 'print position (column, line)'],
  [0x403B, 'CDFLAG', 1, 'bit 7 = SLOW mode running, bit 6 = SLOW wanted'], [0x403C, 'PRBUFF', 33, 'printer buffer'], [0x405D, 'MEMBOT', 30, 'calculator memory']
];
function zx81Text(v) {
  if (v >= 0xC0) { const k = ZX81_TOKENS[v - 0xC0]; return /^[A-Z]/.test(k) && k.length > 1 ? ' ' + k + ' ' : k; }
  if (v >= 0x40 && v <= 0x42) return ['RND', 'INKEY$', 'PI'][v - 0x40];
  if (v & 0x40) return '?';
  return ZX81_CHARS[v & 0x3F];
}
const ZX_CYC_T = { M1: 4, MR: 3, MW: 3, IR: 4, IW: 4, IA: 6 };

// ---- the ZX81's ULA (IC1) and the Z80 as chips with pins ----
// The ULA's pinout is read from Sinclair's circuit diagram SRC 049. Ferranti published no data sheet, so what the chip does
// with its pins is a model of its behaviour: the ZX80's video logic in one package, plus the NMI generator.
// A0'-A8' are the ROM and RAM side of the 1K resistors R18-R26 (the ULA drives them during a refresh cycle to pick a
// character's row in the ROM); D0-D7 are the Z80's side of the 470 ohm resistors R7-R14 (the ULA pulls them low to feed
// the Z80 a NOP, and puts the keyboard on them for a port read). Pin 14 clocks the Z80 through TR2.
const ZX_ULA_PINS = [[1, "A7'"], [2, "A8'"], [3, "A2'"], [4, "A1'"], [5, "A0'"], [6, 'RD'], [7, 'IORQ'], [8, 'WR'], [9, 'MREQ'], [10, 'M1'], [11, 'A14'], [12, 'RAMCS'], [13, 'ROMCS'], [14, 'CLK'], [15, 'NMI'],
  [16, 'TV/TAPE'], [17, 'HALT'], [18, 'A15'], [19, 'D7'], [20, 'TAPE IN'], [21, 'D6'], [22, 'USA/UK'], [23, 'D5'], [24, 'D4'], [25, 'KBD4'], [26, 'D3'], [27, 'KBD3'], [28, 'D2'], [29, 'KBD2'], [30, 'D1'],
  [31, 'KBD1'], [32, 'D0'], [33, 'KBD0'], [34, '0V', 'g'], [35, 'OSC'], [36, "A3'"], [37, "A4'"], [38, "A5'"], [39, "A6'"], [40, '+5V', 'p']].map(([n, name, k]) => [n, name, k || 'i']);
const ZX_Z80_PINS = [[1, 'A11'], [2, 'A12'], [3, 'A13'], [4, 'A14'], [5, 'A15'], [6, 'CLK'], [7, 'D4'], [8, 'D3'], [9, 'D5'], [10, 'D6'], [11, '+5V', 'p'], [12, 'D2'], [13, 'D7'], [14, 'D0'], [15, 'D1'],
  [16, 'INT'], [17, 'NMI'], [18, 'HALT'], [19, 'MREQ'], [20, 'IORQ'], [21, 'RD'], [22, 'WR'], [23, 'BUSACK', 'o'], [24, 'WAIT'], [25, 'BUSREQ'], [26, 'RESET'], [27, 'M1'], [28, 'RFSH', 'o'], [29, 'GND', 'g'],
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => [30 + n, 'A' + n])].map(([n, name, k]) => [n, name, k || 'i']);
if (typeof MEM_PINOUTS !== 'undefined') { MEM_PINOUTS.ULA = ZX_ULA_PINS; MEM_PINOUTS.Z80 = ZX_Z80_PINS; for (const n of ['RAMCS', 'ROMCS', 'NMI', 'HALT', 'MREQ', 'IORQ', 'RD', 'WR', 'M1']) MEM_ACTIVE_LOW.add(n); }
// A chip that is not memory, with pin faults in the same shape as a MemChip: f[pin] is 'z' (disconnected), 0 or 1.
// lv[pin] is the level a faulty pin sits at (a disconnected pin floats high); undefined = no fault.
class ZXChip {
  constructor(id, part, what, range, extra) { Object.assign(this, { id, part, what, range, f: {} }, extra || {}); this.recalc(); }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  recalc() {
    this.lv = {}; let n = 0, dAnd = 0xFF, dOr = 0, m;
    for (const k in this.f) { n++; const v = this.lv[k] = this.f[k] === 'z' ? 1 : this.f[k]; if ((m = /^D(\d)$/.exec(k))) { if (v) dOr |= 1 << +m[1]; else dAnd &= ~(1 << +m[1]); } }
    Object.assign(this, { dAnd, dOr, faulty: n > 0 });
  }
}
class ZX80 {
  constructor(rom, machine) {
    this.rom = new Uint8Array(0x2000); if (rom) this.rom.set(rom.subarray(0, 0x2000));
    this.setMachine(machine || 'zx80');
    this.ram = new Uint8Array(0xC000);         // 4000h-FFFFh
    this.ramSize = 0x400;                      // 1K as supplied (2K on the Timex Sinclair 1000); 16K with the RAM pack; 32K or 48K with bigger packs
    this.lowRam = new Uint8Array(0x2000);      // 8K of RAM at 2000h-3FFFh in place of the ROM's echo (a hi-res board)
    this.hires = false;                        // hi-res board fitted: RAM at 2000h, and RAM answers refresh cycles (WRX)
    // memory chips (src/memchips.js), for the pin display and fault simulation: the ROM (IC2: a 4K 2332 on the ZX80,
    // an 8K 2364 with the 8K ROM), the two 2114s of the built-in 1K (IC3 and IC4 on the ZX80, IC4a and IC4b on the ZX81;
    // which holds which half of the byte is assumed: bits 0-3 in the first) and the 4116s of the RAM packs, one per data bit per 16K.
    // The ZX81 board also takes one 24-pin static RAM in position IC4 in place of the two 2114s. A Timex Sinclair 1000
    // (a Sinclair ZX81 issue 3 board, seen on a real machine) has a 2K NEC uPD4016 there. Measured on that board, and as on Sinclair's diagram SRC 049:
    // CE (pin 18) and OE (20) are joined and reach the ULA's RAMCS (pin 12) through 680 ohms, WE (21) is the Z80's /WR, pin 19 is A10 (link L2).
    const C = (id, part, what, range, arr, base, abits, extra) => new MemChip(id, part, what, range, arr, base, abits, extra);
    this.romChips = [C('IC2', '2332', 'ROM: 4K BASIC', '0000h-0FFFh, repeated up to 3FFFh', this.rom, 0, 12, { rom: true, en: 'CS' }), C('IC2-8K', '2364', 'ROM: 8K BASIC', '0000h-1FFFh, repeated up to 3FFFh', this.rom, 0, 13, { rom: true, en: 'CS', label: 'IC2' })];
    this.ram1k = [C('IC3', '2114', 'built-in RAM, data bits 0-3', '4000h-43FFh, repeated', this.ram, 0, 10, { nib: 0, en: 'CS' }), C('IC4', '2114', 'built-in RAM, data bits 4-7', '4000h-43FFh, repeated', this.ram, 0, 10, { nib: 4, en: 'CS' })];
    this.ram2k = [C('IC4-2K', '4016', 'built-in RAM: one 2K static RAM (Timex Sinclair 1000)', '4000h-47FFh, repeated', this.ram, 0, 11, { en: 'CE', label: 'IC4' })];
    this.packs = [0, 1, 2].map(k => [0, 1, 2, 3, 4, 5, 6, 7].map(bit => C(`PACK${k + 1}.D${bit}`, '4116', `RAM pack: ${k ? ['', 'second', 'third'][k] + ' 16K' : '16K'}, data bit ${bit}`, `${(0x4000 + k * 0x4000).toString(16).toUpperCase()}h-${(0x7FFF + k * 0x4000).toString(16).toUpperCase()}h`, this.ram, k * 0x4000, 14, { dram: true, bit, mux: 7, pack: k })));
    this.chips = [...this.romChips, ...this.ram1k, ...this.packs[0], ...this.packs[1], ...this.packs[2], ...this.ram2k];   // the 2K chip is last so the other indexes stay put
    this.banks = [[this.romChips[0]], [this.romChips[1]], this.ram1k, ...this.packs, this.ram2k];
    // the ULA and the Z80, last so the other indexes stay put. Faults are kept as lines held at a level (netF) and
    // pins disconnected from their line (pinF); applyFaults() turns the two into each chip's own fault table.
    this.ulaC = new ZXChip('ULA', 'ULA', 'Sinclair computer logic (Ferranti ULA): clock, memory selects, keyboard, tape, NMI and video', 'ports with A0 low (read: keyboard; write: NMI on) and A1 low (write: NMI off)', { label: 'IC1' });
    this.z80c = new ZXChip('CPU', 'Z80', 'processor', 'address, data and control lines', { label: 'IC3' });
    this.chips.push(this.ulaC, this.z80c);
    this.pinF = {}; this.netF = {}; this.uv = {}; this.fx = false; this.heldWhy = null;
    this.chipById = {}; for (const c of this.chips) this.chipById[c.id] = c;
    this.acc = new Uint32Array(5);             // accesses: 0 the ROM, 1 the built-in RAM (1K or 2K), 2-4 the RAM pack's 16K banks
    this.faulty = false;
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
    // a held processor (no clock, or RESET, BUSREQ or WAIT low at its pin) does nothing for four clocks at a time
    const run = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => {
      const why = this.heldWhy; if (!why) { this.zr = false; return run(); }
      if (!this.zr && this.z80c.lv.RESET === 0) { this.cpu.reset(); this.zr = true; }     // held in reset by its own pin
      this.cpu.lastEvent = null; return [{ k: 'ID', n: 4, held: why }];
    };
    this.tape = null; this.onTape = () => {};
    this.reset();
  }
  setMachine(m) {
    this.machine = m;
    this.rom8k = m !== 'zx80';          // ZX81 BASIC in an 8K ROM
    this.ula = m === 'zx81';            // NMI generator, free-running sync
    this.romMask = this.rom8k ? 0x1FFF : 0x0FFF;
    if (this.pinF) this.applyFaults();
  }
  // ---- lines and faults ----
  // Which pins share a line on the ZX81 board, for the memory fitted now. d: the pin that drives the line (index into
  // pins), or -1 when several pins drive it in turn. The ZX80 (discrete logic, no diagram filed) and the RAM pack's
  // chips have no lines here: each of their pins counts as a line of its own.
  nets() {
    const sig = this.machine + this.ramSize; if (this.netSig === sig) return this.NETS;
    const N = {}, U = 'ULA', Z = 'CPU';
    if (this.machine === 'zx81') {
      const rom = 'IC2-8K', ram = this.ramSize <= 0x400 ? ['IC3', 'IC4'] : this.ramSize < 0x4000 ? ['IC4-2K'] : [], one = ram.length === 1;
      for (let n = 0; n < 16; n++) {
        const pins = [[Z, 'A' + n]];
        if (n === 6) pins.push([Z, 'INT']);                                   // the Z80's INT pin is wired to A6
        if (n >= 9 && n <= 12) pins.push([rom, 'A' + n]);
        if (n === 9 || n === 10 && one) for (const r of ram) pins.push([r, 'A' + n]);
        if (n >= 14) pins.push([U, 'A' + n]);
        N['A' + n] = { label: n < 9 ? `address line A${n} at the Z80` + (n === 6 ? ' (also its INT pin)' : '') : `address line A${n}`, d: 0, pins };
        if (n < 9) N[`A${n}'`] = { label: `address line A${n}' (the ROM, RAM and ULA side of the 1K resistor)`, d: -1, pins: [[U, `A${n}'`], [rom, 'A' + n], ...ram.map(r => [r, 'A' + n])] };
      }
      for (let n = 0; n < 8; n++) {
        N['D' + n] = { label: `data line D${n} (the Z80 and ULA side of the 470 ohm resistor)`, d: -1, pins: [[Z, 'D' + n], [U, 'D' + n]] };
        N[`D${n}'`] = { label: `data line D${n}' (the ROM and RAM side)`, d: -1, pins: [[rom, 'D' + n], ...(one ? [[ram[0], 'D' + n]] : ram.length ? [[ram[n >> 2], 'I/O' + ((n & 3) + 1)]] : [])] };
      }
      for (const k of ['MREQ', 'IORQ', 'RD', 'M1', 'HALT']) N[k] = { label: k + ' line', d: 0, pins: [[Z, k], [U, k]] };
      N.WR = { label: 'WR line', d: 0, pins: [[Z, 'WR'], [U, 'WR'], ...ram.map(r => [r, 'WE'])] };
      N.NMI = { label: 'NMI line', d: 0, pins: [[U, 'NMI'], [Z, 'NMI']] };
      N.CLK = { label: 'clock from the ULA to the Z80 (through TR2)', d: 0, pins: [[U, 'CLK'], [Z, 'CLK']] };
      N.ROMCS = { label: 'ROM select ROMCS', d: 0, pins: [[U, 'ROMCS'], [rom, 'CS']] };
      N.RAMCS = { label: 'RAM select RAMCS', d: 0, pins: [[U, 'RAMCS'], ...(one ? [[ram[0], 'CE'], [ram[0], 'OE']] : ram.map(r => [r, 'CS']))] };
    }
    const O = {}; for (const k in N) for (const [id, pin] of N[k].pins) O[id + '.' + pin] = k;
    this.NETS = N; this.NET_OF = O; this.netSig = sig; return N;
  }
  netOf(id, pin) { this.nets(); return this.NET_OF[id + '.' + pin] || null; }
  isDriver(id, pin) { const n = this.nets()[this.netOf(id, pin)]; return !!n && n.d >= 0 && n.pins[n.d][0] === id && n.pins[n.d][1] === pin; }
  chipName(id) { return id === 'IC2-8K' ? 'IC2' : this.machine === 'zx81' && id === 'IC3' ? 'IC4a' : this.machine === 'zx81' && id === 'IC4' ? 'IC4b' : this.machine !== 'zx81' && id === 'CPU' ? 'Z80' : this.chipById[id].label || id; }
  // v: 'z' disconnected from its line (floating), 0 or 1 disconnected and at that level, null to reconnect. id 'net' sets a line.
  setPinFault(id, pin, v) { if (id === 'net') return this.setNetFault(pin, v); const k = id + '.' + pin; if (v === null || v === undefined) delete this.pinF[k]; else this.pinF[k] = v; this.applyFaults(); }
  // a whole line held at 0 or 1 (null to release it)
  setNetFault(net, v) { if (v === null || v === undefined) delete this.netF[net]; else this.netF[net] = v; this.applyFaults(); }
  clearFaults() { this.pinF = {}; this.netF = {}; this.applyFaults(); }
  // one chip back to normal: its disconnected pins, and (unless pinsOnly) the held lines its pins are on
  clearChip(id, pinsOnly) {
    const N = this.nets();
    for (const k of Object.keys(this.pinF)) if (k.startsWith(id + '.')) delete this.pinF[k];
    if (!pinsOnly) for (const net of Object.keys(this.netF)) if (!N[net] || N[net].pins.some(p => p[0] === id)) delete this.netF[net];
    this.applyFaults();
  }
  applyFaults() {
    const N = this.nets(), O = this.NET_OF, f = {}; for (const c of this.chips) f[c.id] = {};
    for (const net in this.netF) if (N[net]) for (const [id, pin] of N[net].pins) f[id][pin] = this.netF[net];
    for (const k in this.pinF) {                                                 // an output cut off from its line: the pins that listen see the line float, or the level
      const i = k.indexOf('.'), id = k.slice(0, i), pin = k.slice(i + 1), net = O[k], L = net && N[net];
      if (L && !(net in this.netF) && L.d >= 0 && L.pins[L.d][0] === id && L.pins[L.d][1] === pin) for (const [i2, p2] of L.pins) if (i2 !== id || p2 !== pin) f[i2][p2] = this.pinF[k];
    }
    for (const k in this.pinF) { const i = k.indexOf('.'); if (f[k.slice(0, i)]) f[k.slice(0, i)][k.slice(i + 1)] = this.pinF[k]; }
    if (this.machine !== 'zx81') f.ULA = {};                                     // no ULA on a ZX80
    for (const c of this.chips) { c.f = f[c.id]; c.recalc(); }
    for (const b of this.banks) memBankFlag(b);
    this.faulty = this.chips.some(c => c.faulty);
    this.refault();
  }
  // the faults as set, for lists: [id, pin, text]; a line has id 'net'
  faultList() {
    const N = this.nets(), out = [];
    for (const net in this.netF) if (N[net]) out.push(['net', net, `${N[net].label} held ${this.netF[net] ? 'high' : 'low'} (${N[net].pins.length} pin${N[net].pins.length === 1 ? '' : 's'})`]);
    for (const k in this.pinF) {
      const i = k.indexOf('.'), id = k.slice(0, i), pin = k.slice(i + 1), v = this.pinF[k], shared = this.NET_OF[k] && N[this.NET_OF[k]].pins.length > 1;
      if (id === 'ULA' && this.machine !== 'zx81') continue;
      out.push([id, pin, `${this.chipName(id)} pin ${pin} ${shared ? 'disconnected from its line' + (v === 'z' ? '' : v ? ', at high' : ', at low') : v === 'z' ? 'disconnected' : v ? 'stuck high' : 'stuck low'}`]);
    }
    return out;
  }
  // the same for one chip's caption
  chipFaults(id) {
    const N = this.nets(), out = [];
    for (const k in this.pinF) if (k.startsWith(id + '.')) { const v = this.pinF[k], shared = this.NET_OF[k] && N[this.NET_OF[k]].pins.length > 1; out.push(k.slice(id.length + 1) + (shared ? (v === 'z' ? ' disconnected' : v ? ' disconnected, high' : ' disconnected, low') : v === 'z' ? ' disconnected' : v ? ' stuck high' : ' stuck low')); }
    for (const net in this.netF) if (N[net]) for (const [i2, pin] of N[net].pins) if (i2 === id && !((id + '.' + pin) in this.pinF)) out.push(`${pin}: line held ${this.netF[net] ? 'high' : 'low'}`);
    return out;
  }
  // Faults changed: work out what they mean for the buses and for the ULA.
  //   the Z80's pins: an address or data pin at a level changes the bus for everything; INT, NMI, WAIT, RESET, BUSREQ and CLK act on the Z80
  //   uv: the levels the ULA sees on its faulty pins (its own, and those of the lines they are on)
  refault() {
    const z = this.z80c.lv, u = this.uv = this.machine === 'zx81' ? this.ulaC.lv : {}; let aAnd = 0xFFFF, aOr = 0, m, cutD = 0, cutA = 0;
    for (const k in z) if ((m = /^A(\d+)$/.exec(k))) { if (z[k]) aOr |= 1 << +m[1]; else aAnd &= ~(1 << +m[1]); }
    if (this.machine === 'zx81') for (const k in this.pinF) { if ((m = /^ULA\.D(\d)$/.exec(k))) cutD |= 1 << +m[1]; else if ((m = /^ULA\.A(\d)'$/.exec(k))) cutA |= 1 << +m[1]; }
    const uf = Object.keys(u).length > 0;
    Object.assign(this, { bAAnd: aAnd, bAOr: aOr, bDAnd: this.z80c.dAnd, bDOr: this.z80c.dOr, busF: this.z80c.faulty, uCutD: cutD, uCutA: cutA,
      uDAnd: uf ? this.ulaC.dAnd : 0xFF, uDOr: uf ? this.ulaC.dOr : 0, fx: this.z80c.faulty || uf,
      memDead: z.MREQ === 1, wrDead: z.WR === 1, nmiCut: z.NMI !== undefined, ackLost: u.IORQ === 1 || u.M1 === 1,
      oscDead: 'OSC' in u, tvDead: 'TV/TAPE' in u || 'OSC' in u });
    this.heldWhy = 'OSC' in u ? 'no clock: the ULA\'s oscillator is stopped' : 'CLK' in u ? 'no clock: the ULA\'s clock does not reach the Z80' : 'CLK' in z ? 'no clock at the Z80\'s CLK pin'
      : z.RESET === 0 ? 'RESET is low at the Z80: it is held in reset' : z.BUSREQ === 0 ? 'BUSREQ is low at the Z80: it has released the bus' : z.WAIT === 0 ? 'WAIT is low at the Z80: it waits' : null;
    if (z.NMI === 0 && !this.nmiLow) this.cpu.nmiPending = true;                 // the pin going low is one falling edge
    this.nmiLow = z.NMI === 0;
  }
  held() { return this.heldWhy; }
  // an address or data byte as it stands on the Z80's side of the bus
  busA(a) { return this.busF ? a & this.bAAnd | this.bAOr : a; }
  busD(v) { return this.busF ? v & this.bDAnd | this.bDOr : v; }
  // Does the ULA take the byte of this opcode fetch as a character? It does when it sees A15 high, M1 low, HALT high
  // and bit 6 of the data low. Returns the byte as the ULA reads it on its data pins, or -1.
  ulaChar(a, halted) {
    const u = this.uv, A = this.busA(a);
    if (!(u.A15 !== undefined ? u.A15 : A >> 15) || u.M1 === 1 || u.HALT === 0 || halted && u.HALT !== 1) return -1;
    const d = this.mreadF(a, true, true) & this.uDAnd | this.uDOr;
    return d & 0x40 ? -1 : d;
  }
  reset() {
    this.cpu.reset();
    this.nmiGen = false; this.nextH = Infinity; this.nmis = 0; this.hiresBytes = 0;
    this.t = 0;                 // T-states since power-on
    this.lcntr = 0;             // 74LS393 line counter (character row 0-7)
    this.vsync = false; this.vsyncStart = 0;
    this.intLevel = false;      // /INT from A6 of the last refresh address
    this.latch = 0; this.lastChar = -1;
    this.lineStart = 0; this.line = 0; this.hsyncEnd = -1;
    this.frames = 0; this.synced = false;
    this.fb.fill(0); this.front.fill(0);
    this.tapeWaiting = false; this.tapeRefused = null;
  }
  // ---- memory ----
  // Up to 16K: A14 selects ROM or RAM and A15 is ignored (it is the video trigger), so everything echoes above
  // 8000h. A 32K or 48K pack puts real RAM above 8000h for data; opcode fetches from C000h up still see the echo
  // of 4000h-7FFFh, because that is where the display file is "executed". The hi-res board replaces the ROM's
  // echo at 2000h-3FFFh with 8K of RAM.
  // ramAt: index into this.ram for an address, or -1 (not main RAM); m1 = opcode fetch
  ramAt(a, m1) {
    if (this.ramSize > 0x4000 && a >= 0x4000 && a < 0x4000 + this.ramSize && !(m1 && a >= 0xC000)) return a - 0x4000;
    a &= 0x7FFF;
    return a & 0x4000 ? (a - 0x4000) & (this.ramSize - 1) & 0x3FFF : -1;
  }
  // memory through the chips; quiet = no side effects and no access counting (the panes, the display)
  ramBank(i) { return this.ramSize <= 0x400 ? this.ram1k : this.ramSize < 0x4000 ? this.ram2k : this.packs[i >> 14]; }
  ramGet(i, quiet) {
    if (!quiet) this.acc[this.ramSize < 0x4000 ? 1 : 2 + (i >> 14)]++;
    if (!this.faulty) return this.ram[i];
    const bank = this.ramBank(i); let v = bank.faulty ? memBankRead(bank, i & 0x3FFF, quiet) : this.ram[i];
    const r = this.romChips[this.rom8k ? 1 : 0]; if (r.always) v &= memBankRead([r], i & this.romMask, true);      // ROM chip select stuck low: it drives the bus too
    return v;
  }
  romGet(o, quiet) {
    if (!quiet) this.acc[0]++;
    const r = this.romChips[this.rom8k ? 1 : 0];
    return this.faulty && r.faulty ? memBankRead([r], o, quiet) : this.rom[o];
  }
  // read: what the Z80 gets. mread: the board with no faults on the Z80's or the ULA's pins (chip faults included).
  read(a, m1, quiet) { return this.fx ? this.busD(this.mreadF(a, m1, quiet)) : this.mread(a, m1, quiet); }
  // with faults: the address as it leaves the Z80, and the ROM and the built-in RAM selected by what the ULA sees on
  // MREQ and A14. A RAM pack decodes the address itself and is not misled; an unselected bus reads FFh (pull-ups).
  mreadF(a, m1, quiet) {
    const A = this.busA(a), u = this.uv;
    if (this.memDead) return 0xFF;
    const dead = u.MREQ === 1;
    if (!dead && u.A14 === undefined) return this.mread(A, m1, quiet);
    const i = this.ramAt(A, m1), low = i < 0 && this.hires && (A & 0x7FFF) >= 0x2000 && (A & 0x7FFF) < 0x4000;
    if (low) return this.lowRam[(A & 0x7FFF) - 0x2000];
    if (this.ramSize >= 0x4000) {
      if (i >= 0) { const v = this.ramGet(i, quiet); return !dead && !u.A14 ? v & this.romGet(A & this.romMask, true) : v; }
      return dead || u.A14 ? 0xFF : this.romGet(A & this.romMask, quiet);
    }
    if (dead) return 0xFF;
    return u.A14 ? this.ramGet(A & (this.ramSize - 1), quiet) : this.romGet(A & this.romMask, quiet);
  }
  mread(a, m1, quiet) {
    const i = this.ramAt(a, m1); if (i >= 0) return this.ramGet(i, quiet);
    a &= 0x7FFF;
    return this.hires && a >= 0x2000 ? this.lowRam[a - 0x2000] : this.romGet(a & this.romMask, quiet);
  }
  peek(a) { return this.read(a, false, true); }
  write(a, v) {
    if (this.fx) {
      if (this.memDead || this.wrDead) return;
      a = this.busA(a); v = this.busD(v);
      const u = this.uv;
      if (this.ramSize < 0x4000 && (u.MREQ === 1 || u.A14 !== undefined)) { if (u.MREQ === 1 || !u.A14) return; a = 0x4000 | a & 0x3FFF; }
    }
    const i = this.ramAt(a, false);
    if (i >= 0) { this.acc[this.ramSize < 0x4000 ? 1 : 2 + (i >> 14)]++; const bank = this.faulty ? this.ramBank(i) : null; if (bank && bank.faulty) memBankWrite(bank, i & 0x3FFF, v); else this.ram[i] = v; return; }
    a &= 0x7FFF; if (this.hires && a >= 0x2000) this.lowRam[a - 0x2000] = v;
  }
  // the byte RAM puts on the bus during a refresh cycle (address I:R), or -1 if no RAM answers. A plain ZX81's
  // RAM is switched off during refresh; the hi-res board (and WRX-modified RAM packs) answer, which is how true
  // high resolution works: the picture byte comes straight from RAM instead of the ROM's character set.
  refreshRam(ra) {
    if (!this.hires) return -1;
    const i = this.ramAt(ra, false); if (i >= 0) return this.ramGet(i, true);
    ra &= 0x7FFF; return ra >= 0x2000 && ra < 0x4000 ? this.lowRam[ra - 0x2000] : -1;
  }
  // opcode fetch: above 8000h a byte with bit 6 clear is a character; the CPU is given a NOP
  fetch(a) {
    if (this.fx) {                        // with faults: what the ULA sees decides, and it can only pull down the data pins it still has
      const ch = this.ulaChar(a, false); if (ch < 0) return this.read(a, true);
      this.latch = ch; this.acc[this.ramAt(this.busA(a), true) >= 0 ? (this.ramSize < 0x4000 ? 1 : 2) : 0]++;
      return this.busD(this.mreadF(a, true, true) & this.uCutD);
    }
    const v = this.read(a, true);
    if ((a & 0x8000) && !(v & 0x40)) { this.latch = v; return 0x00; }
    return v;
  }
  // ---- I/O: only A0 is decoded ----
  input(p) {
    if (this.fx) {                        // the ULA answers when it sees IORQ, RD and A0' low; a data pin it has lost floats high
      const u = this.uv; p = this.busA(p);
      if (u.IORQ === 1 || u.RD === 1 || (u["A0'"] !== undefined ? u["A0'"] : p & 1)) return this.busD(0xFF);
      if (!this.vsync && !(this.ula && this.nmiGen)) { this.vsync = true; this.vsyncStart = this.t; }
      let d = 0x1F; for (let r = 0; r < 8; r++) if (!(p & (0x100 << r))) d &= ~this.keys[r];
      for (let n = 0; n < 5; n++) if (u['KBD' + n] !== undefined) d = u['KBD' + n] ? d | 1 << n : d & ~(1 << n);
      const tape = u['TAPE IN'] !== undefined ? u['TAPE IN'] : this.rom8k ? 0 : 1;
      return this.busD(d | 0x20 | (u['USA/UK'] === 0 ? 0 : 0x40) | tape << 7 | this.uCutD);
    }
    if (p & 1) return 0xFF;
    if (!this.vsync && !(this.ula && this.nmiGen)) { this.vsync = true; this.vsyncStart = this.t; }   // a read with A0 low starts vertical sync (not while the ZX81's NMIs run)
    let d = 0x1F;
    for (let r = 0; r < 8; r++) if (!(p & (0x100 << r))) d &= ~this.keys[r];
    // D5 unused; D6 high = 50 Hz (the 8K ROM sets a 55-line MARGIN from it); D7 is the tape input, no signal = low
    // for the 8K ROM (it reads a high bit 7 as a tape pulse); the 4K ROM's loader is happy either way
    return (d & 0x1F) | 0x60 | (this.rom8k ? 0 : 0x80);
  }
  output(p) {
    if (this.fx) {                        // the ULA acts when it sees IORQ and WR low, on what it sees on A0' and A1'
      const u = this.uv; if (u.IORQ === 1 || u.WR === 1) return;
      p = this.busA(p); for (const n of [0, 1]) if (u[`A${n}'`] !== undefined) p = u[`A${n}'`] ? p | 1 << n : p & ~(1 << n);
    }
    if (this.ula) {                       // ZX81: A0 low (OUT FEh) starts the NMI generator, A1 low (OUT FDh) stops it
      if (!(p & 1)) { if (!this.nmiGen) { this.nmiGen = true; if (this.nextH === Infinity) this.nextH = this.t + ZX.LINE_T; } }
      else if (!(p & 2)) this.nmiGen = false;
    }
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
  // ZX81: the ULA's horizontal syncs, every 207 T-states; each one is an NMI while the generator is on
  hsyncs() {
    if (this.oscDead) { while (this.nextH <= this.t) this.nextH += ZX.LINE_T; return; }     // no oscillator: no sync, no NMI
    while (this.nextH <= this.t) {
      this.newLine(this.nextH + ZX.ULA_HSYNC_LEN);
      if (this.nmiGen && !this.nmiCut) { this.cpu.nmiPending = true; this.nmis++; }
      if (this.ackLost) this.lcntr = (this.lcntr + 1) & 7;
      this.nextH += ZX.LINE_T;
    }
  }
  // ZX81 /WAIT: an NMI arriving while the CPU is halted is taken exactly at the sync, not at the end of a HALT cycle
  waitSync() {
    if (this.z80c.lv.WAIT === undefined && this.ula && this.nmiGen && this.cpu.halted && !this.cpu.nmiPending && this.nextH < this.t + 4) { this.t = Math.max(this.t, this.nextH); this.hsyncs(); }
  }
  preStep() { this.tapeTrap(); this.waitSync(); }
  freeRun() {   // without horizontal sync the TV's own oscillator starts new lines
    while (this.t - this.lineStart > ZX.LINE_T * 1.25) this.newLine(this.lineStart + ZX.LINE_T);
  }
  plot(at, bits) {
    if (this.tvDead) return;
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
    if (this.rom8k) return this.tapeTrap81();
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
    // after an error the ROM keeps listening, as a real ZX80 would; tapeWaiting stays set so the error stays on show
    const b = this.tape, n = ZX80.tapeNeeds(b);
    if (n < 0x28 || n > b.length) { this.tape = null; this.tapeWaiting = true; this.onTape('error', `LOAD: that file is not a ZX80 program (it is ${b.length} bytes; its E_LINE says ${Math.max(0, n)}). Press SPACE for BREAK.`); return; }
    if (n > this.ramSize) { this.tapeWaiting = true; if (this.tapeRefused === b) return; this.tapeRefused = b; this.onTape('error', `LOAD: this program needs ${Math.ceil(n / 1024)}K of RAM. Choose the 16K RAM pack (the tape stays in), then type LOAD again.`); return; }
    this.tape = null; this.tapeWaiting = false;
    this.ram.set(b.subarray(0, n), 0);
    this.cpu.pc = 0x0283;
    this.onTape('load', n);
  }
  // 8K ROM (ZX81 BASIC): SAVE is intercepted at 02FBh, after the name is checked (DE points at it, last letter
  // has bit 7 set); LOAD at its byte reader 034Ch, whose return address is dropped. Both leave through 0207h,
  // which puts SLOW mode back. A .p file is RAM from 4009h (VERSN) up to the byte before E_LINE (4014h).
  tapeHooked81() { const r = this.rom; return r[0x2FB] === 0xEB && r[0x34C] === 0x0E && r[0x34E] === 0x06 && r[0x207] === 0x21 && r[0x1FE] === 0x2A; }
  tapeTrap81() {
    const pc = this.cpu.pc;
    if (this.tapeWaiting && (pc < 0x0340 || pc > 0x03A7)) { this.tapeWaiting = false; this.onTape('idle'); }   // LOAD was broken off
    if ((pc !== 0x02FB && pc !== 0x034C) || this.cpu.halted || !this.tapeHooked81()) return;
    if (pc === 0x02FB) {
      let name = '', a = (this.cpu.d << 8) | this.cpu.e;
      for (let i = 0; i < 127; i++, a++) { const v = this.read(a); name += ZX81_CHARS[v & 0x3F] || '?'; if (v & 0x80) break; }
      const end = this.peekW(0x4014), n = end - 0x4009;
      if (n < 0x74 || end > 0x4000 + this.ramSize) this.onTape('error', `SAVE: the system variables look damaged (E_LINE ${end.toString(16).toUpperCase()}h), nothing saved.`);
      else this.onTape('save', this.ram.slice(9, 9 + n), name.trim());
      this.cpu.pc = 0x0207; return;
    }
    if (!this.tape) { if (!this.tapeWaiting) { this.tapeWaiting = true; this.onTape('wait'); } return; }
    const b = this.tape, n = ZX80.tapeNeeds81(b) - 9;
    if (n < 0x74 || n > b.length) { this.tape = null; this.tapeWaiting = true; this.onTape('error', `LOAD: that file is not a ZX81 program (it is ${b.length} bytes; its E_LINE says ${Math.max(0, n)}). Press SPACE for BREAK.`); return; }
    if (9 + n > this.ramSize) { this.tapeWaiting = true; if (this.tapeRefused === b) return; this.tapeRefused = b; this.onTape('error', `LOAD: this program needs ${Math.ceil((9 + n) / 1024)}K of RAM. Choose the 16K RAM pack (the tape stays in), then type LOAD "" again.`); return; }
    this.tape = null; this.tapeWaiting = false;
    this.ram.set(b.subarray(0, n), 9);
    this.cpu.sp = (this.cpu.sp + 2) & 0xFFFF; this.cpu.pc = 0x0207;
    this.onTape('load', n);
  }
  static tapeNeeds81(b) { return b && b.length >= 0x0D ? (b[0x0B] | b[0x0C] << 8) - 0x4000 : 0; }   // bytes of RAM a .p file fills
  insertTape(bytes) { this.tape = bytes; this.tapeRefused = null; }
  static tapeNeeds(b) { return b && b.length >= 0x0C ? (b[0x0A] | b[0x0B] << 8) - 0x4000 : 0; }   // bytes of RAM a .o file fills
  peekW(a) { return this.read(a) | this.read(a + 1) << 8; }
  // ---- RAM listing: system variables, memory areas, the BASIC program as text and a hex dump ----
  ramReport() {
    if (this.rom8k) return this.ramReport81();
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
  ramReport81() {
    const h4 = v => v.toString(16).toUpperCase().padStart(4, '0') + 'h', h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    const top = 0x4000 + this.ramSize, out = [], w = a => this.peekW(a);
    out.push(`${this.machine === 'zx81' ? 'Sinclair ZX81' : 'Sinclair ZX80 with the 8K ROM'} RAM dump: ${this.ramSize / 1024}K at 4000h-${h4(top - 1)}`, '');
    out.push('System variables');
    for (const [a, name, n, what] of ZX81_SYSVARS) out.push(`  ${h4(a)}  ${name.padEnd(7)} ${n === 2 ? h4(w(a)) : n === 1 ? h2(this.read(a)) + 'h  ' : '(' + n + ' bytes)'}   ${what}`);
    const dfile = w(0x400C), vars = w(0x4010), eline = w(0x4014), stkbot = w(0x401A), stkend = w(0x401C), ramtop = w(0x4004), sp = this.cpu.sp;
    out.push('', 'Memory areas');
    const area = (a, b, what) => out.push(`  ${h4(a)}-${h4(Math.max(a, b - 1))}  ${String(Math.max(0, b - a)).padStart(5)} bytes  ${what}`);
    area(0x4000, 0x407D, 'system variables (a .p file starts at 4009h)'); area(0x407D, dfile, 'BASIC program'); area(dfile, vars, 'display file');
    area(vars, eline, 'variables (ends with 80h)'); area(eline, stkbot, 'line being edited'); area(stkbot, stkend, 'calculator stack');
    area(stkend, sp, 'free'); area(sp, ramtop, 'machine stack (SP ' + h4(sp) + ')'); if (ramtop < top) area(ramtop, top, 'above RAMTOP');
    out.push('', 'BASIC program (numbers shown as typed; each is followed in memory by 7Eh and its 5-byte value)');
    let a = 0x407D, lines = 0;
    while (a < dfile && a < top && lines < 2000) {
      const num = this.read(a) << 8 | this.read(a + 1), len = this.read(a + 2) | this.read(a + 3) << 8; let s = '', q = a + 4;
      const end = Math.min(q + len, dfile);
      while (q < end && this.read(q) !== 0x76) { const v = this.read(q); if (v === 0x7E) { q += 6; continue; } s += zx81Text(v); q++; }
      a += 4 + len; lines++; out.push(String(num).padStart(6) + ' ' + s.replace(/ {2,}/g, ' ').trim());
    }
    if (!lines) out.push('  (none)');
    out.push('', 'Hex dump (characters in the ZX81 set; inverse in lower case, tokens as ~, NEWLINE as |)');
    for (let r = 0x4000; r < top; r += 16) {
      const bytes = []; let txt = '';
      for (let i = 0; i < 16; i++) { const v = this.read(r + i); bytes.push(h2(v)); txt += v === 0x76 ? '|' : v >= 0xC0 || (v >= 0x40 && v < 0x80) ? (v >= 0xC0 ? '~' : '.') : v & 0x80 ? ZX81_CHARS[v & 0x3F].toLowerCase() : ZX81_CHARS[v]; }
      out.push(`${h4(r)}  ${bytes.slice(0, 8).join(' ')}  ${bytes.slice(8).join(' ')}  ${txt}`);
    }
    return out.join('\n') + '\n';
  }
  // ---- per instruction: interrupts, video, sync ----
  syncInt() { const i = this.z80c.lv.INT; this.cpu.intLine = i !== undefined ? i === 0 : this.intLevel; }
  afterStep(cyc) {
    const t0 = this.t; let off = 0, last = null;
    for (const c of cyc) {
      const n = ZX_CYC_T[c.k] || c.n || 0;
      c.t0 = t0 + off;                    // when the cycle began, for the clock-by-clock view
      if (this.fx ? c.k === 'M1' : c.k === 'M1' && !c.halt && (c.a & 0x8000) && c.d === 0x00) {
        const v = this.fx ? this.ulaChar(c.a, c.halt) : this.read(c.a, true);
        if (v >= 0 && !(v & 0x40)) {   // a character: font byte from I:R with the character code and line counter
          let rf = c.rf, fa = (rf & 0xFE00) | ((v & 0x3F) << 3) | this.lcntr;
          if (this.fx) { rf = this.busA(rf); fa = (rf & 0xFE00) | (fa & ~this.uCutA | rf & this.uCutA) & 0x1FF; }   // an address pin the ULA has lost keeps the refresh address
          const hr = this.refreshRam(rf);
          let bits = hr >= 0 ? hr : fa & 0x4000 ? 0 : this.romGet(fa & this.romMask, true);
          if (this.fx) bits = bits & this.uDAnd | this.uDOr;
          if (hr >= 0) this.hiresBytes++;
          if (v & 0x80) bits ^= 0xFF;
          this.plot(t0 + off + 4, bits); this.lastChar = v; c.ch = v; c.fa = fa;
        }
      }
      off += n; last = c;
    }
    this.t = t0 + off;
    if (this.cpu.lastEvent === 'INT' && this.ackLost) { if (this.nextH === Infinity) this.nextH = t0 + ZX.LINE_T; }      // the ULA misses the acknowledge: its sync counter runs free
    else if (this.cpu.lastEvent === 'INT') {   // acknowledge: next character row line, then horizontal sync
      this.lcntr = (this.lcntr + 1) & 7;
      if (this.ula) this.nextH = t0 + ZX.ULA_HSYNC_DELAY;          // ZX81: the acknowledge re-phases the ULA's sync counter
      else this.newLine(t0 + ZX.HSYNC_DELAY + ZX.HSYNC_LEN);
    }
    if (this.ula) this.hsyncs();
    this.intLevel = !!(last && last.k === 'M1' && !(this.busA(last.rf) & 0x40));
    this.freeRun();
  }
  step() {
    this.preStep(); this.syncInt();
    const cyc = this.cpu.step();
    this.afterStep(cyc);
    let t = 0; for (const c of cyc) t += ZX_CYC_T[c.k] || c.n || 0;
    return t;
  }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  // is the ULA's horizontal sync pulse on at T-state at? (ZX81; worked out from the next pulse, so approximate just after an interrupt acknowledge)
  hsyncAt(at) { if (!this.ula || this.oscDead || !isFinite(this.nextH)) return false; let d = (at - this.nextH) % ZX.LINE_T; if (d < 0) d += ZX.LINE_T; return d < ZX.ULA_HSYNC_LEN; }
  beam() { return { line: this.line, x: Math.max(0, (this.t - this.lineStart) * 2) }; }
}
if (typeof module !== 'undefined') module.exports = { ZX80, ZXChip, ZX_ULA_PINS, ZX, ZX_KEYS, ZX_TOKENS, zxText, ZX81_TOKENS, zx81Text };
