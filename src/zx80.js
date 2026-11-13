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
    // (a Sinclair ZX81 issue 3 board, seen on a real machine) has a 2K NEC uPD4016 there; how its enables are wired is assumed.
    const C = (id, part, what, range, arr, base, abits, extra) => new MemChip(id, part, what, range, arr, base, abits, extra);
    this.romChips = [C('IC2', '2332', 'ROM: 4K BASIC', '0000h-0FFFh, repeated up to 3FFFh', this.rom, 0, 12, { rom: true, en: 'CS' }), C('IC2-8K', '2364', 'ROM: 8K BASIC', '0000h-1FFFh, repeated up to 3FFFh', this.rom, 0, 13, { rom: true, en: 'CS' })];
    this.ram1k = [C('IC3', '2114', 'built-in RAM, data bits 0-3', '4000h-43FFh, repeated', this.ram, 0, 10, { nib: 0, en: 'CS' }), C('IC4', '2114', 'built-in RAM, data bits 4-7', '4000h-43FFh, repeated', this.ram, 0, 10, { nib: 4, en: 'CS' })];
    this.ram2k = [C('IC4-2K', '4016', 'built-in RAM: one 2K static RAM (Timex Sinclair 1000)', '4000h-47FFh, repeated', this.ram, 0, 11, { en: 'CE', label: 'IC4' })];
    this.packs = [0, 1, 2].map(k => [0, 1, 2, 3, 4, 5, 6, 7].map(bit => C(`PACK${k + 1}.D${bit}`, '4116', `RAM pack: ${k ? ['', 'second', 'third'][k] + ' 16K' : '16K'}, data bit ${bit}`, `${(0x4000 + k * 0x4000).toString(16).toUpperCase()}h-${(0x7FFF + k * 0x4000).toString(16).toUpperCase()}h`, this.ram, k * 0x4000, 14, { dram: true, bit, mux: 7, pack: k })));
    this.chips = [...this.romChips, ...this.ram1k, ...this.packs[0], ...this.packs[1], ...this.packs[2], ...this.ram2k];   // the 2K chip is last so the other indexes stay put
    this.banks = [[this.romChips[0]], [this.romChips[1]], this.ram1k, ...this.packs, this.ram2k];
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
    this.tape = null; this.onTape = () => {};
    this.reset();
  }
  setMachine(m) {
    this.machine = m;
    this.rom8k = m !== 'zx80';          // ZX81 BASIC in an 8K ROM
    this.ula = m === 'zx81';            // NMI generator, free-running sync
    this.romMask = this.rom8k ? 0x1FFF : 0x0FFF;
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
  read(a, m1, quiet) {
    const i = this.ramAt(a, m1); if (i >= 0) return this.ramGet(i, quiet);
    a &= 0x7FFF;
    return this.hires && a >= 0x2000 ? this.lowRam[a - 0x2000] : this.romGet(a & this.romMask, quiet);
  }
  peek(a) { return this.read(a, false, true); }
  write(a, v) {
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
    const v = this.read(a, true);
    if ((a & 0x8000) && !(v & 0x40)) { this.latch = v; return 0x00; }
    return v;
  }
  // ---- I/O: only A0 is decoded ----
  input(p) {
    if (p & 1) return 0xFF;
    if (!this.vsync && !(this.ula && this.nmiGen)) { this.vsync = true; this.vsyncStart = this.t; }   // a read with A0 low starts vertical sync (not while the ZX81's NMIs run)
    let d = 0x1F;
    for (let r = 0; r < 8; r++) if (!(p & (0x100 << r))) d &= ~this.keys[r];
    // D5 unused; D6 high = 50 Hz (the 8K ROM sets a 55-line MARGIN from it); D7 is the tape input, no signal = low
    // for the 8K ROM (it reads a high bit 7 as a tape pulse); the 4K ROM's loader is happy either way
    return (d & 0x1F) | 0x60 | (this.rom8k ? 0 : 0x80);
  }
  output(p) {
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
    while (this.nextH <= this.t) {
      this.newLine(this.nextH + ZX.HSYNC_LEN);
      if (this.nmiGen) { this.cpu.nmiPending = true; this.nmis++; }
      this.nextH += ZX.LINE_T;
    }
  }
  // ZX81 /WAIT: an NMI arriving while the CPU is halted is taken exactly at the sync, not at the end of a HALT cycle
  waitSync() {
    if (this.ula && this.nmiGen && this.cpu.halted && !this.cpu.nmiPending && this.nextH < this.t + 4) { this.t = Math.max(this.t, this.nextH); this.hsyncs(); }
  }
  preStep() { this.tapeTrap(); this.waitSync(); }
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
  syncInt() { this.cpu.intLine = this.intLevel; }
  afterStep(cyc) {
    const t0 = this.t; let off = 0, last = null;
    for (const c of cyc) {
      const n = ZX_CYC_T[c.k] || c.n || 0;
      if (c.k === 'M1' && !c.halt && (c.a & 0x8000) && c.d === 0x00) {
        const v = this.read(c.a, true);
        if (!(v & 0x40)) {   // a character: font byte from I:R with the character code and line counter
          const fa = (c.rf & 0xFE00) | ((v & 0x3F) << 3) | this.lcntr, hr = this.refreshRam(c.rf);
          let bits = hr >= 0 ? hr : fa & 0x4000 ? 0 : this.romGet(fa & this.romMask, true);
          if (hr >= 0) this.hiresBytes++;
          if (v & 0x80) bits ^= 0xFF;
          this.plot(t0 + off + 4, bits); this.lastChar = v;
        }
      }
      off += n; last = c;
    }
    this.t = t0 + off;
    if (this.cpu.lastEvent === 'INT') {   // acknowledge: next character row line, then horizontal sync
      this.lcntr = (this.lcntr + 1) & 7;
      if (this.ula) this.nextH = t0 + ZX.HSYNC_DELAY;          // ZX81: the acknowledge re-phases the ULA's sync counter
      else this.newLine(t0 + ZX.HSYNC_DELAY + ZX.HSYNC_LEN);
    }
    if (this.ula) this.hsyncs();
    this.intLevel = !!(last && last.k === 'M1' && !(last.rf & 0x40));
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
  beam() { return { line: this.line, x: Math.max(0, (this.t - this.lineStart) * 2) }; }
}
if (typeof module !== 'undefined') module.exports = { ZX80, ZX, ZX_KEYS, ZX_TOKENS, zxText, ZX81_TOKENS, zx81Text };
