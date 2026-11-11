// MSX1 machine model for Z80 Bench, set up as the Sony HB-55P (16K RAM) or HB-75P (64K RAM).
// An MSX is a Z80A at 3.58 MHz with three support chips:
//   TMS9929A video processor (ports 98h data, 99h control/status): 16K of its own video RAM, four screen
//     modes, 32 sprites, and the machine's only interrupt, once per frame (50 Hz on these PAL machines).
//   8255 PPI (ports A8h-ABh): port A is the slot-select register, port B reads the keyboard columns,
//     port C picks the keyboard row (bits 0-3) and drives the cassette motor, cassette output, CAPS lamp and
//     key click.
//   AY-3-8910 sound generator (ports A0h address, A1h write, A2h read): its I/O port A reads the joysticks
//     and the cassette input.
// Memory is four 16K pages; each page shows one of four primary slots, chosen by two bits of PPI port A
// (bits 1-0 page 0 ... bits 7-6 page 3). Slot 0 holds the 32K BIOS + BASIC ROM, on these Sonys also the 16K
// Personal Data Bank firmware at 8000h, and on the HB-55P its 16K of RAM at C000h. Slots 1 and 3 are the
// cartridge slots. The HB-75P has 64K of RAM in slot 2.
// Cassette: .cas tape images are handled by trapping the BIOS tape routines (TAPION 00E1h, TAPIN 00E4h, TAPIOF
// 00E7h, TAPOON 00EAh, TAPOUT 00EDh, TAPOOF 00F0h) instead of modelling the audio signal, so loading and saving
// are instant. A .cas file is the bytes of each tape block, every block preceded by an 8-byte marker.
// Sound: the AY-3-8910's three square-wave tone channels, noise generator and envelope are computed sample by
// sample as emulated time passes (when audioRate is set) into a ring buffer the page plays; the 1-bit key click
// on PPI port C bit 7 is mixed in.
// The Z80 on an MSX gets one wait state in every opcode fetch, so M1 cycles take 5 T-states.

const MSX = {
  CPU_HZ: 3579545,
  LINE_T: 228,              // T-states per scan line (CPU clock = video clock / 3)
  LINES: 313,               // PAL
  W: 256, H: 192, BORDER: 12,
  PALETTE: [[0, 0, 0], [0, 0, 0], [33, 200, 66], [94, 220, 120], [84, 85, 237], [125, 118, 252], [212, 82, 77], [66, 235, 245],
            [252, 85, 84], [255, 121, 120], [212, 193, 84], [230, 206, 128], [33, 176, 59], [201, 91, 186], [204, 204, 204], [255, 255, 255]],
  COLOUR_NAMES: ['transparent', 'black', 'medium green', 'light green', 'dark blue', 'light blue', 'dark red', 'cyan', 'medium red', 'light red', 'dark yellow', 'light yellow', 'dark green', 'magenta', 'grey', 'white'],
  MODE_NAMES: { g1: 'Graphics I (SCREEN 1)', g2: 'Graphics II (SCREEN 2)', text: 'Text 40x24 (SCREEN 0)', mc: 'Multicolour (SCREEN 3)' }
};
MSX.FW = MSX.W + 2 * MSX.BORDER; MSX.FH = MSX.H + 2 * MSX.BORDER;
// Keyboard matrix (international layout): row selected by PPI port C bits 0-3, columns read on port B, active low.
const MSX_KEYS = [
  ['0', '1', '2', '3', '4', '5', '6', '7'],
  ['8', '9', '-', '=', '\\', '[', ']', ';'],
  ["'", '`', ',', '.', '/', 'Dead', 'A', 'B'],
  ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'],
  ['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R'],
  ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'],
  ['Shift', 'Ctrl', 'Graph', 'Caps', 'Code', 'F1', 'F2', 'F3'],
  ['F4', 'F5', 'Esc', 'Tab', 'Stop', 'BS', 'Select', 'Return'],
  ['Space', 'Home', 'Ins', 'Del', 'Left', 'Up', 'Down', 'Right']
];
const MSX_KEYPOS = {}; MSX_KEYS.forEach((row, r) => row.forEach((k, c) => { MSX_KEYPOS[k] = [r, c]; }));
const MSX_CAS_HDR = [0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74];
const MSX_PSG_VOL = [0, 0.0078, 0.011, 0.0156, 0.0221, 0.0313, 0.0442, 0.0625, 0.0884, 0.125, 0.1768, 0.25, 0.3536, 0.5, 0.7071, 1];
const MSX_PSG_TICK_HZ = MSX.CPU_HZ / 16;      // a tone output flips every (period) of these ticks; noise and envelope step every 2 x period
const MSX_CYC_T = { M1: 5, MR: 3, MW: 3, IR: 4, IW: 4, IA: 7 };

// MSX BASIC keywords: tokens 81h-FCh, and the functions that follow an FFh prefix (81h-B0h)
const MSX_TOKENS = ['END', 'FOR', 'NEXT', 'DATA', 'INPUT', 'DIM', 'READ', 'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB', 'RETURN', 'REM', 'STOP', 'PRINT', 'CLEAR', 'LIST', 'NEW',
  'ON', 'WAIT', 'DEF', 'POKE', 'CONT', 'CSAVE', 'CLOAD', 'OUT', 'LPRINT', 'LLIST', 'CLS', 'WIDTH', 'ELSE', 'TRON', 'TROFF', 'SWAP', 'ERASE', 'ERROR', 'RESUME', 'DELETE',
  'AUTO', 'RENUM', 'DEFSTR', 'DEFINT', 'DEFSNG', 'DEFDBL', 'LINE', 'OPEN', 'FIELD', 'GET', 'PUT', 'CLOSE', 'LOAD', 'MERGE', 'FILES', 'LSET', 'RSET', 'SAVE', 'LFILES', 'CIRCLE',
  'COLOR', 'DRAW', 'PAINT', 'BEEP', 'PLAY', 'PSET', 'PRESET', 'SOUND', 'SCREEN', 'VPOKE', 'SPRITE', 'VDP', 'BASE', 'CALL', 'TIME', 'KEY', 'MAX', 'MOTOR', 'BLOAD', 'BSAVE',
  'DSKO$', 'SET', 'NAME', 'KILL', 'IPL', 'COPY', 'CMD', 'LOCATE', 'TO', 'THEN', 'TAB(', 'STEP', 'USR', 'FN', 'SPC(', 'NOT', 'ERL', 'ERR', 'STRING$', 'USING',
  'INSTR', "'", 'VARPTR', 'CSRLIN', 'ATTR$', 'DSKI$', 'OFF', 'INKEY$', 'POINT', '>', '=', '<', '+', '-', '*', '/', '^', 'AND', 'OR', 'XOR', 'EQV', 'IMP', 'MOD', '\\'];
const MSX_FUNCS = ['LEFT$', 'RIGHT$', 'MID$', 'SGN', 'INT', 'ABS', 'SQR', 'RND', 'SIN', 'LOG', 'EXP', 'COS', 'TAN', 'ATN', 'FRE', 'INP', 'POS', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$', 'PEEK', 'VPEEK',
  'SPACE$', 'OCT$', 'HEX$', 'LPOS', 'BIN$', 'CINT', 'CSNG', 'CDBL', 'FIX', 'STICK', 'STRIG', 'PDL', 'PAD', 'DSKF', 'FPOS', 'CVI', 'CVS', 'CVD', 'EOF', 'LOC', 'LOF', 'MKI$', 'MKS$', 'MKD$'];
const MSX_SYSVARS = [
  [0xF672, 'MEMSIZ', 2, 'top of string space'], [0xF674, 'STKTOP', 2, 'top of the machine stack'], [0xF676, 'TXTTAB', 2, 'start of the BASIC program'],
  [0xF6C2, 'VARTAB', 2, 'start of simple variables (end of program)'], [0xF6C4, 'ARYTAB', 2, 'start of arrays'], [0xF6C6, 'STREND', 2, 'end of arrays (start of free space)'],
  [0xF69B, 'FRETOP', 2, 'bottom of used string space'], [0xFC48, 'BOTTOM', 2, 'lowest RAM address found'], [0xFC4A, 'HIMEM', 2, 'highest address BASIC may use'],
  [0xF41C, 'CURLIN', 2, 'line being run (FFFFh = direct mode)'], [0xFCAF, 'SCRMOD', 1, 'screen mode'], [0xF3B0, 'LINLEN', 1, 'line width'],
  [0xF3DC, 'CSRY', 1, 'cursor row'], [0xF3DD, 'CSRX', 1, 'cursor column'], [0xF3E9, 'FORCLR', 1, 'foreground colour'], [0xF3EA, 'BAKCLR', 1, 'background colour'], [0xF3EB, 'BDRCLR', 1, 'border colour'],
  [0xF3DF, 'RG0SAV', 1, 'copy of VDP register 0'], [0xF3E0, 'RG1SAV', 1, 'copy of VDP register 1'], [0xF3E7, 'STATFL', 1, 'copy of the VDP status'],
  [0xFC9E, 'JIFFY', 2, 'frame counter (TIME)'], [0xFCAB, 'CAPST', 1, 'CAPS lock state'], [0xF3F8, 'PUTPNT', 2, 'keyboard buffer: next free'], [0xF3FA, 'GETPNT', 2, 'keyboard buffer: next to read'],
  [0xFCC1, 'EXPTBL', 1, 'slot 0 expanded flag / main ROM slot'], [0xFAF8, 'EXBRSA', 1, 'sub-ROM slot (0 on MSX1)']
];

// A cartridge: a plain ROM placed at its base address, or a "mega ROM" whose 8K segments are switched by
// writes into the cartridge's own address space (four common mapper types).
const MSX_MAPPERS = { plain: 'plain ROM', konami: 'Konami', scc: 'Konami SCC', ascii8: 'ASCII 8K', ascii16: 'ASCII 16K' };
class MSXCart {
  constructor(rom, type) {
    this.rom = rom; this.len = rom.length; this.name = '';
    this.type = type || MSXCart.guess(rom);
    this.base = 0x4000; this.reset();
    if (this.type === 'plain') {
      const ab = o => rom[o] === 0x41 && rom[o + 1] === 0x42, w = o => rom[o] | rom[o + 1] << 8;
      if (this.len > 0x8000) this.base = ab(0x4000) || this.len > 0xC000 ? 0 : 0x4000;
      else if (this.len <= 0x4000 && ab(0)) { const init = w(2); if ((init === 0 && w(8)) || (init >= 0x8000 && init < 0xC000)) this.base = 0x8000; }
    }
  }
  reset() { this.bank = this.type === 'ascii8' ? [0, 0, 0, 0] : this.type === 'ascii16' ? [0, 1, 0, 1] : [0, 1, 2, 3]; }
  // how openMSX-style guessing works: count the LD (nnnn),A instructions that write to each mapper's switch addresses
  static guess(rom) {
    if (rom.length <= 0x10000) return 'plain';
    const n = { konami: 0, scc: 0, ascii8: 0, ascii16: 0 };
    for (let i = 0; i < rom.length - 2; i++) if (rom[i] === 0x32) {
      const a = rom[i + 1] | rom[i + 2] << 8;
      if (a === 0x5000 || a === 0x9000 || a === 0xB000) n.scc += 2;
      else if (a === 0x4000 || a === 0x8000 || a === 0xA000) n.konami += 2;
      else if (a === 0x6800 || a === 0x7800) n.ascii8 += 2;
      else if (a === 0x6000) { n.konami++; n.ascii8++; n.ascii16++; }
      else if (a === 0x7000) { n.scc++; n.ascii8++; n.ascii16++; }
      else if (a === 0x77FF) n.ascii16 += 2;
    }
    let best = 'ascii8'; for (const k of ['konami', 'scc', 'ascii16']) if (n[k] > n[best]) best = k;
    return best;
  }
  read(a) {
    if (this.type === 'plain') {
      if (this.len <= 0x4000) {
        if (a < this.base || a >= 0xC000) return 0xFF;
        return this.rom[(a - this.base) % this.len];          // 8K and 16K ROMs repeat up to BFFFh
      }
      const o = a - this.base; return o >= 0 && o < this.len ? this.rom[o] : 0xFF;
    }
    if (a < 0x4000 || a >= 0xC000) return 0xFF;
    return this.rom[(this.bank[(a - 0x4000) >> 13] * 0x2000 + (a & 0x1FFF)) % this.len];
  }
  write(a, v) {
    const b = this.bank;
    switch (this.type) {
      case 'konami': if (a >= 0x6000 && a < 0xC000) b[(a - 0x4000) >> 13] = v; break;
      case 'scc': if ((a & 0x1800) === 0x1000 && a >= 0x5000 && a < 0xC000) b[(a - 0x4000) >> 13] = v; break;
      case 'ascii8': if (a >= 0x6000 && a < 0x8000) b[(a >> 11) & 3] = v; break;
      case 'ascii16': if (a >= 0x6000 && a < 0x6800) { b[0] = v * 2; b[1] = v * 2 + 1; } else if (a >= 0x7000 && a < 0x7800) { b[2] = v * 2; b[3] = v * 2 + 1; } break;
    }
  }
}

class MSXMachine {
  constructor() {
    this.bios = new Uint8Array(0x8000); this.hasBios = false;
    this.fw = new Uint8Array(0x4000); this.hasFw = false; this.fwOn = true;
    this.ram = new Uint8Array(0x10000);
    this.setMachine('hb55p');
    this.carts = [null, null, null, null];          // by primary slot; 1 and 3 are the cartridge slots
    this.vram = new Uint8Array(0x4000);
    this.vreg = new Uint8Array(8);
    this.psg = new Uint8Array(16);
    this.keys = new Uint8Array(11);                 // bit set = key down
    this.joy = 0x3F;                                // joystick port 1, active low: up down left right A B
    this.fb = new Uint8Array(MSX.FW * MSX.FH);      // picture being drawn, as palette numbers
    this.front = new Uint8Array(MSX.FW * MSX.FH);   // last complete picture
    this.sprLine = new Uint8Array(256); this.sprHit = new Uint8Array(256);
    this.bus = { read: a => this.read(a), write: (a, v) => this.write(a, v), input: p => this.input(p), output: (p, v) => this.output(p, v) };
    this.cpu = new Z80(this.bus);
    this.cpu.intVector = 0xFF;
    this.audioRate = 0; this.abuf = new Float32Array(32768); this.aw = 0; this.audioT = 0;
    this.tape = null; this.tapePos = 0; this.rec = []; this.onTape = () => {};
    this.reset();
  }
  // HB-55P: 16K of RAM at C000h in slot 0. HB-75P: 64K of RAM in slot 2.
  setMachine(m) { this.machine = m; this.ramSlot = m === 'hb75p' ? 2 : 0; this.ramBase = m === 'hb75p' ? 0 : 0xC000; this.ramSize = 0x10000 - this.ramBase; }
  reset() {
    this.cpu.reset();
    this.t = 0; this.nextLine = MSX.LINE_T; this.line = 0; this.frames = 0;
    this.ppiA = 0; this.ppiC = 0; this.ppiCtl = 0x82;
    this.vreg.fill(0); this.vstat = 0; this.vaddr = 0; this.vbuf = 0; this.vlatch = -1;
    this.psg.fill(0); this.psgAddr = 0; this.psg[7] = 0xFF;
    this.toneCnt = [0, 0, 0]; this.toneOut = [0, 0, 0]; this.noiseCnt = 0; this.lfsr = 1; this.envCnt = 0; this.envPos = 0;
    for (const c of this.carts) if (c) c.reset();
    this.fb.fill(1); this.front.fill(1);
    this.vdpWrites = 0; this.ints = 0;
  }
  // ---- memory: page -> primary slot -> device ----
  slotOf(page) { return (this.ppiA >> (page * 2)) & 3; }
  // what a slot holds at an address: 'bios', 'fw', 'ram', 'cart' or null (nothing: reads FFh)
  device(slot, a) {
    if (slot === this.ramSlot && a >= this.ramBase) return 'ram';
    if (slot === 0) { if (a < 0x8000) return 'bios'; if (a < 0xC000 && this.hasFw && this.fwOn) return 'fw'; return null; }
    return this.carts[slot] ? 'cart' : null;
  }
  readSlot(slot, a) {
    switch (this.device(slot, a)) {
      case 'ram': return this.ram[a];
      case 'bios': return this.bios[a];
      case 'fw': return this.fw[a - 0x8000];
      case 'cart': return this.carts[slot].read(a);
    }
    return 0xFF;
  }
  read(a) { return this.readSlot((this.ppiA >> ((a >> 14) * 2)) & 3, a); }
  peek(a) { return this.read(a); }
  peekW(a) { return this.read(a) | this.read((a + 1) & 0xFFFF) << 8; }
  write(a, v) {
    const slot = (this.ppiA >> ((a >> 14) * 2)) & 3, d = this.device(slot, a);
    if (d === 'ram') this.ram[a] = v; else if (d === 'cart') this.carts[slot].write(a, v);
  }
  // ---- I/O ports ----
  input(p) {
    switch (p & 0xFF) {
      case 0x98: { const v = this.vbuf; this.vbuf = this.vram[this.vaddr]; this.vaddr = (this.vaddr + 1) & 0x3FFF; this.vlatch = -1; return v; }
      case 0x99: { const v = this.vstat; this.vstat &= 0x1F; this.vlatch = -1; return v; }
      case 0xA2: return this.psgAddr === 14 ? (this.joy & 0x3F) | 0x40 | 0x80 : this.psg[this.psgAddr & 15];   // bit 6: ANSI keyboard; bit 7: cassette input
      case 0xA8: return this.ppiA;
      case 0xA9: { const row = this.ppiC & 15; return row < 11 ? ~this.keys[row] & 0xFF : 0xFF; }
      case 0xAA: return this.ppiC;
      case 0xAB: return this.ppiCtl;
    }
    return 0xFF;
  }
  output(p, v) {
    switch (p & 0xFF) {
      case 0x98: this.vram[this.vaddr] = v; this.vbuf = v; this.vaddr = (this.vaddr + 1) & 0x3FFF; this.vlatch = -1; this.vdpWrites++; break;
      case 0x99:
        if (this.vlatch < 0) { this.vlatch = v; break; }
        if (v & 0x80) this.vreg[v & 7] = this.vlatch;
        else { this.vaddr = ((v & 0x3F) << 8) | this.vlatch; if (!(v & 0x40)) { this.vbuf = this.vram[this.vaddr]; this.vaddr = (this.vaddr + 1) & 0x3FFF; } }
        this.vlatch = -1; break;
      case 0xA0: this.psgAddr = v & 15; break;
      case 0xA1: this.psg[this.psgAddr] = v; if (this.psgAddr === 13) { this.envPos = 0; this.envCnt = 0; } break;      // writing the shape restarts the envelope
      case 0xA8: this.ppiA = v; break;
      case 0xAA: this.ppiC = v; break;
      case 0xAB:
        if (v & 0x80) { this.ppiCtl = v; this.ppiC = 0; }                       // mode word: outputs are cleared
        else { const b = 1 << ((v >> 1) & 7); this.ppiC = v & 1 ? this.ppiC | b : this.ppiC & ~b; }   // set or clear one bit of port C
        break;
    }
  }
  key(name, down) { const p = MSX_KEYPOS[name]; if (!p) return; if (down) this.keys[p[0]] |= 1 << p[1]; else this.keys[p[0]] &= ~(1 << p[1]); }
  // ---- video ----
  mode() { const r0 = this.vreg[0], r1 = this.vreg[1]; return r1 & 0x10 ? 'text' : r1 & 0x08 ? 'mc' : r0 & 0x02 ? 'g2' : 'g1'; }
  // where the tables are in video RAM, from registers 2-6 (Graphics II masks the pattern and colour tables)
  tables() {
    const r = this.vreg, m = this.mode(), g2 = m === 'g2';
    return {
      mode: m, name: (r[2] & 0x0F) << 10,
      colour: g2 ? (r[3] & 0x80) << 6 : r[3] << 6, colourMask: g2 ? ((r[3] & 0x7F) << 6) | 0x3F : 0x3FFF, colourLen: g2 ? 0x1800 : m === 'g1' ? 32 : 0,
      pattern: g2 ? (r[4] & 0x04) << 11 : (r[4] & 0x07) << 11, patternMask: g2 ? ((r[4] & 0x03) << 11) | 0x7FF : 0x3FFF, patternLen: g2 ? 0x1800 : 0x800,
      nameLen: m === 'text' ? 960 : 768,
      sprAttr: (r[5] & 0x7F) << 7, sprPattern: (r[6] & 0x07) << 11
    };
  }
  renderLine(y) {
    const r = this.vreg, vr = this.vram, fb = this.fb, B = MSX.BORDER, FW = MSX.FW;
    const bd = r[7] & 15 || 1, row = (y + B) * FW;
    for (let x = 0; x < B; x++) { fb[row + x] = bd; fb[row + B + 256 + x] = bd; }
    const out = row + B;
    if (!(r[1] & 0x40)) { for (let x = 0; x < 256; x++) fb[out + x] = bd; return; }      // display blanked
    const T = this.tables(), cr = y >> 3, fy = y & 7;
    if (T.mode === 'text') {
      const fg = r[7] >> 4 || bd, bg = r[7] & 15 || bd;
      for (let x = 0; x < 8; x++) { fb[out + x] = bg; fb[out + 248 + x] = bg; }
      for (let cx = 0; cx < 40; cx++) {
        const bits = vr[(T.pattern + vr[(T.name + cr * 40 + cx) & 0x3FFF] * 8 + fy) & 0x3FFF], o = out + 8 + cx * 6;
        for (let k = 0; k < 6; k++) fb[o + k] = bits & (0x80 >> k) ? fg : bg;
      }
      return;
    }
    for (let cx = 0; cx < 32; cx++) {
      const ch = vr[(T.name + cr * 32 + cx) & 0x3FFF], o = out + cx * 8;
      if (T.mode === 'mc') {
        const c = vr[(T.pattern + ch * 8 + ((y >> 2) & 7)) & 0x3FFF], l = c >> 4 || bd, rr = c & 15 || bd;
        for (let k = 0; k < 4; k++) { fb[o + k] = l; fb[o + 4 + k] = rr; }
        continue;
      }
      let bits, col;
      if (T.mode === 'g2') {
        const i = ((cr & 0x18) << 5 | ch) * 8 + fy;          // each third of the screen has its own 256 patterns
        bits = vr[T.pattern + (i & T.patternMask)]; col = vr[T.colour + (i & T.colourMask)];
      } else { bits = vr[(T.pattern + ch * 8 + fy) & 0x3FFF]; col = vr[(T.colour + (ch >> 3)) & 0x3FFF]; }
      const fg = col >> 4 || bd, bg = col & 15 || bd;
      for (let k = 0; k < 8; k++) fb[o + k] = bits & (0x80 >> k) ? fg : bg;
    }
    // sprites: at most four on a line; the fifth sets a status flag. Lower-numbered sprites are in front.
    const size = r[1] & 2 ? 16 : 8, mag = r[1] & 1, h = size << mag, sl = this.sprLine, hit = this.sprHit;
    let n = 0, any = false, last = 31;
    for (let i = 0; i < 32; i++) {
      const a = T.sprAttr + i * 4; let sy = vr[a];
      if (sy === 208) { last = i; break; }
      if (sy > 208) sy -= 256;
      sy++;
      if (y < sy || y >= sy + h) continue;
      if (++n > 4) { if (!(this.vstat & 0x40)) this.vstat = (this.vstat & 0xE0) | 0x40 | i; last = -1; break; }
      if (!any) { sl.fill(0); hit.fill(0); any = true; }
      const colb = vr[a + 3], c = colb & 15, line = (y - sy) >> mag, pat = size === 16 ? vr[a + 2] & 0xFC : vr[a + 2];
      let x = vr[a + 1] - (colb & 0x80 ? 32 : 0);
      const pa = T.sprPattern + pat * 8 + line;
      const bits = size === 16 ? vr[pa & 0x3FFF] << 8 | vr[(pa + 16) & 0x3FFF] : vr[pa & 0x3FFF] << 8;
      for (let k = 0; k < size; k++) {
        if (bits & (0x8000 >> k)) for (let m = 0; m <= mag; m++) {
          const xx = x + (k << mag) + m; if (xx < 0 || xx > 255) continue;
          if (hit[xx]) this.vstat |= 0x20; else hit[xx] = 1;
          if (!sl[xx] && c) sl[xx] = c;
        }
      }
    }
    if (last >= 0 && !(this.vstat & 0x40)) this.vstat = (this.vstat & 0xE0) | last;
    if (any) for (let x = 0; x < 256; x++) if (sl[x]) fb[out + x] = sl[x];
  }
  endFrame() {
    const bd = this.vreg[7] & 15 || 1, B = MSX.BORDER, FW = MSX.FW;
    this.fb.fill(bd, 0, B * FW); this.fb.fill(bd, (B + 192) * FW);
    const f = this.front; this.front = this.fb; this.fb = f;
    this.frames++;
  }
  // ---- per instruction ----
  // ---- sound ----
  envLevel() {      // 0-15 from the envelope shape (register 13: continue, attack, alternate, hold) and position
    const sh = this.psg[13], cyc = this.envPos >> 4, i = this.envPos & 15, up0 = !!(sh & 4), alt = !!(sh & 2);
    if (cyc >= 1) { if (!(sh & 8)) return 0; if (sh & 1) return up0 !== alt ? 15 : 0; }
    const up = alt && (cyc & 1) ? !up0 : up0;
    return up ? i : 15 - i;
  }
  audioSample() {
    const g = this.psg, ticks = MSX_PSG_TICK_HZ / this.audioRate, mix = g[7];
    const np = ((g[6] & 31) || 1) * 2; this.noiseCnt += ticks;
    while (this.noiseCnt >= np) { this.noiseCnt -= np; const b = (this.lfsr ^ (this.lfsr >> 3)) & 1; this.lfsr = (this.lfsr >> 1) | (b << 16); }
    const ep = ((g[11] | g[12] << 8) || 1) * 2; this.envCnt += ticks;
    while (this.envCnt >= ep) { this.envCnt -= ep; if (++this.envPos >= 64) this.envPos -= 32; }
    const noise = this.lfsr & 1; let out = 0;
    for (let ch = 0; ch < 3; ch++) {
      const p = (g[ch * 2] | (g[ch * 2 + 1] & 15) << 8) || 1;
      this.toneCnt[ch] += ticks;
      if (this.toneCnt[ch] >= p) { const n = Math.floor(this.toneCnt[ch] / p); this.toneCnt[ch] -= n * p; if (n & 1) this.toneOut[ch] ^= 1; }
      const on = (this.toneOut[ch] | ((mix >> ch) & 1)) & (noise | ((mix >> (ch + 3)) & 1));
      if (on) { const v = g[8 + ch]; out += MSX_PSG_VOL[v & 16 ? this.envLevel() : v & 15]; }
    }
    return out / 3 + (this.ppiC & 0x80 ? 0.25 : 0);
  }
  // ---- cassette ----
  insertTape(bytes) { this.tape = bytes; this.tapePos = 0; }
  casHeaderAt(p) { const t = this.tape; for (let i = 0; i < 8; i++) if (t[p + i] !== MSX_CAS_HDR[i]) return false; return true; }
  // the files on the tape: BASIC (CLOAD), binary (BLOAD) and ASCII (LOAD) files start with a block of ten marker bytes and a 6-letter name
  tapeFiles() {
    const out = [], t = this.tape; if (!t) return out;
    for (let p = 0; p + 24 <= t.length; p += 8) {
      if (!this.casHeaderAt(p)) continue;
      const m = t[p + 8], kind = m === 0xD3 ? 'basic' : m === 0xD0 ? 'binary' : m === 0xEA ? 'ascii' : null; if (!kind) continue;
      let same = true; for (let i = 1; i < 10; i++) if (t[p + 8 + i] !== m) same = false; if (!same) continue;
      let name = ''; for (let i = 0; i < 6; i++) { const c = t[p + 18 + i]; name += c >= 32 && c < 127 ? String.fromCharCode(c) : ' '; }
      out.push({ kind, name: name.trim(), at: p });
    }
    return out;
  }
  tapeTrap() {
    const c = this.cpu, pc = c.pc;
    if (pc < 0xE1 || pc > 0xF0 || (pc - 0xE1) % 3 || !this.hasBios || (this.ppiA & 3) !== 0 || c.halted) return;
    let cy = 0;
    switch (pc) {
      case 0xE1: {   // TAPION: find the next block; returns with interrupts off, carry set on failure
        let found = -1; if (this.tape) for (let p = (this.tapePos + 7) & ~7; p + 8 <= this.tape.length; p += 8) if (this.casHeaderAt(p)) { found = p; break; }
        if (found < 0) { cy = 1; this.onTape('error', this.tape ? 'end' : 'none'); } else { this.tapePos = found + 8; this.onTape('block', found); }
        c.iff1 = c.iff2 = 0; break;
      }
      case 0xE4: if (this.tape && this.tapePos < this.tape.length) c.a = this.tape[this.tapePos++]; else cy = 1; break;   // TAPIN: one byte in A
      case 0xE7: c.iff1 = c.iff2 = 1; this.onTape('idle'); break;                                                       // TAPIOF
      case 0xEA: while (this.rec.length % 8) this.rec.push(0); this.rec.push(...MSX_CAS_HDR); c.iff1 = c.iff2 = 0; break; // TAPOON: start a block
      case 0xED: this.rec.push(c.a); break;                                                                              // TAPOUT: one byte from A
      case 0xF0: c.iff1 = c.iff2 = 1; this.onTape('recorded', this.rec.length); break;                                   // TAPOOF
    }
    c.f = (c.f & 0xFE) | cy;
    c.pc = this.read(c.sp) | this.read((c.sp + 1) & 0xFFFF) << 8; c.sp = (c.sp + 2) & 0xFFFF;                          // RET
  }
  preStep() { this.tapeTrap(); }
  intOut() { return !!(this.vstat & 0x80) && !!(this.vreg[1] & 0x20); }      // the VDP's /INT pin: frame flag and interrupt enable
  syncInt() { this.cpu.intLine = this.intOut(); }
  afterStep(cyc) {
    let t = 0; for (const c of cyc) t += MSX_CYC_T[c.k] || c.n || 0;
    this.t += t;
    if (this.audioRate) { this.audioT += t * this.audioRate; while (this.audioT >= MSX.CPU_HZ) { this.audioT -= MSX.CPU_HZ; this.abuf[this.aw++ & 32767] = this.audioSample(); } }
    if (this.cpu.lastEvent === 'INT') this.ints++;
    while (this.t >= this.nextLine) {
      this.nextLine += MSX.LINE_T;
      if (this.line < 192) this.renderLine(this.line);
      this.line++;
      if (this.line === 192) { this.vstat |= 0x80; this.endFrame(); }      // end of the picture: frame flag, and /INT if enabled
      if (this.line >= MSX.LINES) this.line = 0;
    }
    return t;
  }
  step() { this.preStep(); this.syncInt(); return this.afterStep(this.cpu.step()); }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  beam() { return { line: this.line, x: Math.min(255, Math.max(0, Math.round((this.t - (this.nextLine - MSX.LINE_T)) * 342 / 228) - 40)) }; }
  // ---- the screen as text (modes with a character grid) ----
  screenText() {
    const T = this.tables(), w = T.mode === 'text' ? 40 : 32, out = [];
    for (let y = 0; y < 24; y++) { let s = ''; for (let x = 0; x < w; x++) { const c = this.vram[(T.name + y * w + x) & 0x3FFF]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 255 ? '█' : '.'; } out.push(s.replace(/\s+$/, '')); }
    return out;
  }
  // ---- BASIC program as text ----
  basicNumber(a, n) {    // BCD floating point: sign and exponent byte, then n mantissa bytes
    const e = this.read(a); if (!e) return '0';
    let d = ''; for (let i = 1; i <= n; i++) d += this.read(a + i).toString(16).padStart(2, '0');
    const exp = (e & 0x7F) - 0x40; d = d.replace(/0+$/, '') || '0';
    let s;
    if (exp > 14 || exp < -3) s = d[0] + (d.length > 1 ? '.' + d.slice(1) : '') + 'E' + (exp - 1 >= 0 ? '+' : '') + (exp - 1);
    else if (exp <= 0) s = '.' + '0'.repeat(-exp) + d;
    else if (d.length <= exp) s = d + '0'.repeat(exp - d.length);
    else s = d.slice(0, exp) + '.' + d.slice(exp);
    return (e & 0x80 ? '-' : '') + s;
  }
  basicLine(a, end) {
    let s = '', quote = false, rem = false, data = false; const rd = x => this.read(x & 0xFFFF);
    while (a < end) {
      const c = rd(a++); if (!c) break;
      if (quote || rem) { if (c === 0x22 && !rem) quote = false; s += c >= 32 && c < 127 ? String.fromCharCode(c) : '{' + c.toString(16).toUpperCase().padStart(2, '0') + '}'; continue; }
      if (c === 0x22) { quote = true; s += '"'; continue; }
      if (data) { if (c === 0x3A) data = false; s += String.fromCharCode(c); continue; }
      if (c === 0x3A && rd(a) === 0x8F && rd(a + 1) === 0xE6) { s += "'"; a += 2; rem = true; continue; }
      if (c === 0x3A && rd(a) === 0xA1) { s += 'ELSE'; a++; continue; }
      if (c === 0xFF) { const f = MSX_FUNCS[rd(a++) - 0x81]; s += f || '?'; continue; }
      if (c >= 0x81) { const k = MSX_TOKENS[c - 0x81] || '?'; s += k; if (c === 0x8F) rem = true; if (c === 0x84) data = true; continue; }
      if (c === 0x0B) { s += '&O' + (rd(a) | rd(a + 1) << 8).toString(8); a += 2; continue; }
      if (c === 0x0C) { s += '&H' + (rd(a) | rd(a + 1) << 8).toString(16).toUpperCase(); a += 2; continue; }
      if (c === 0x0D) { const p = rd(a) | rd(a + 1) << 8; s += rd(p + 3) | rd(p + 4) << 8; a += 2; continue; }      // pointer to the target line, once the program has run
      if (c === 0x0E || c === 0x1C) { s += rd(a) | rd(a + 1) << 8; a += 2; continue; }
      if (c === 0x0F) { s += rd(a++); continue; }
      if (c >= 0x11 && c <= 0x1A) { s += c - 0x11; continue; }
      if (c === 0x1D) { const v = this.basicNumber(a, 3); s += v + (/[.E]/.test(v) ? '' : '!'); a += 4; continue; }
      if (c === 0x1F) { const v = this.basicNumber(a, 7); s += v + (/E/.test(v) ? '' : '#'); a += 8; continue; }
      s += c >= 32 && c < 127 ? String.fromCharCode(c) : '{' + c.toString(16).toUpperCase().padStart(2, '0') + '}';
    }
    return s;
  }
  basicListing() {
    const out = []; let a = this.peekW(0xF676), guard = 0; const end = this.peekW(0xF6C2);
    if (a < 0x8000 || end < a) return out;
    while (guard++ < 5000) {
      const next = this.peekW(a); if (!next || next <= a || next > end) break;
      out.push(this.peekW(a + 2) + ' ' + this.basicLine(a + 4, next));
      a = next;
    }
    return out;
  }
  ramReport() {
    const h2 = v => v.toString(16).toUpperCase().padStart(2, '0'), h4 = v => v.toString(16).toUpperCase().padStart(4, '0'), out = [], c = this.cpu;
    out.push(`MSX RAM listing: Sony ${this.machine === 'hb75p' ? 'HB-75P, 64K RAM in slot 2' : 'HB-55P, 16K RAM at C000h in slot 0'}`);
    out.push(`CPU  PC ${h4(c.pc)}  SP ${h4(c.sp)}  AF ${h2(c.a)}${h2(c.f)}  BC ${h2(c.b)}${h2(c.c)}  DE ${h2(c.d)}${h2(c.e)}  HL ${h2(c.h)}${h2(c.l)}  IX ${h4(c.ix)}  IY ${h4(c.iy)}  IM ${c.im}  IFF1 ${c.iff1}`);
    out.push(`Slots  PPI port A = ${h2(this.ppiA)}h: ` + [0, 1, 2, 3].map(p => `page ${p} (${h4(p << 14)}h) slot ${this.slotOf(p)}`).join(', '), '');
    out.push('System variables');
    for (const [a, name, w, what] of MSX_SYSVARS) out.push(`  ${h4(a)}  ${name.padEnd(7)} ${w === 2 ? h4(this.peekW(a)) : h2(this.read(a)) + 'h  '}   ${what}`);
    out.push('', 'VDP registers  ' + [...this.vreg].map((v, i) => `R${i}=${h2(v)}`).join(' ') + `  status ${h2(this.vstat)}  mode: ${MSX.MODE_NAMES[this.mode()]}`);
    const T = this.tables(); out.push(`  name table ${h4(T.name)}h  pattern table ${h4(T.pattern)}h  colour table ${h4(T.colour)}h  sprite attributes ${h4(T.sprAttr)}h  sprite patterns ${h4(T.sprPattern)}h`);
    out.push('', 'BASIC program'); const prog = this.basicListing(); out.push(...(prog.length ? prog.map(l => '  ' + l) : ['  (none)']));
    if (T.mode === 'text' || T.mode === 'g1') out.push('', 'Screen', ...this.screenText().map(l => '  |' + l));
    const dump = (title, get, from, to) => {
      out.push('', title);
      for (let a = from; a < to; a += 16) {
        let hx = '', as = '', zero = true; for (let i = 0; i < 16; i++) { const v = get(a + i); if (v) zero = false; hx += h2(v) + ' '; as += v >= 32 && v < 127 ? String.fromCharCode(v) : '.'; }
        if (!zero) out.push(`  ${h4(a)}  ${hx} ${as}`);
      }
    };
    dump(`RAM ${h4(this.ramBase)}h-FFFFh (rows of zeros left out)`, a => this.ram[a], this.ramBase, 0x10000);
    dump('Video RAM 0000h-3FFFh (rows of zeros left out)', a => this.vram[a], 0, 0x4000);
    return out.join('\n') + '\n';
  }
}
if (typeof module !== 'undefined') module.exports = { MSXMachine, MSXCart, MSX, MSX_KEYS, MSX_TOKENS };
