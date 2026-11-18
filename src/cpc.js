// Amstrad CPC 464 machine model for Z80 Bench: the processor, the memory, the 6845 and the gate array's video,
// with the 8255, the sound chip, the keyboard matrix and the cassette.
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
//          Each is a chip with pin faults: B is the gate array's CPU (low for a CPU access), A its CAS ADDR (low for
//          the column); inputs 0-1 are the CPU's column and row bits, 2-3 the display's (6845 MA/RA lines, and CCLK
//          for the byte's half). A fault on an input, a select or an enable changes the RAM address the CPU or the
//          display uses (selMap); a fault on an output reaches the RAM's address pins.
//   IC107  8255 (M5L8255AP): port A the sound chip's data; PC0-PC3 the keyboard row (to IC101, a 74LS145), PC4 the
//          cassette motor, PC5 the tape output, PC6-PC7 the sound chip's BC1 and BDIR; PB0 VSYNC, PB1-PB4 the links,
//          PB5 EXP, PB6 the printer's BUSY, PB7 the tape input. CS is A11, A1 is A9, A0 is A8. A chip with pin faults.
//   IC102  AY-3-8912 sound chip: CLOCK is CCLK (1 MHz), BC2 and A8 tied high, IO0-IO7 read the keyboard's columns.
//          A chip with pin faults.
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
// Faults. There are two kinds, and the machine keeps them apart (pinF and netF):
//   - a pin disconnected from its line (a broken trace, a lifted pin): only that chip is affected. An input pin then
//     floats high, or can be given a level of its own; an output pin no longer drives its line, which floats high
//     for the pins that listen to it;
//   - a line held high or low (a short on the wire): every pin on that line sees the level, on every chip, unless
//     the pin is itself disconnected from the line.
// CPC_NETS lists which pins share each line. applyFaults() turns the two lists into each chip's own fault table
// (chip.f), which is what the chip models and the pin display use. The Z80 (IC111) is a chip object too: a level on
// one of its address, data or control pins acts on the bus for every device, whether or not it is drawn as a chip.
// RESET is one line for the board: chipReset() resets the Z80, the gate array, the 6845, the sound chip and the 8255 (on its own active-high line), each
// unless its own RESET pin is held high or disconnected; a chip whose RESET pin is low stays in reset.
// Clocks: the 16 MHz oscillator feeds the gate array (CK16), which makes PHI (4 MHz, to the Z80) and CCLK (1 MHz, to
// the 6845 and the sound chip). Without CK16 the gate array and everything it times stop. Without PHI, or with READY
// held low, the Z80 is held (cpu.step returns one idle character of four clocks) while the video goes on. Without
// CCLK the 6845's counters stand still. With READY held high the Z80 is never made to wait: ROM reads still work,
// but a RAM access that is out of step with the gate array's RAM cycle reads what the RAM last put out, and a write
// is lost. That last part is an approximation of what the board would do.
const CPC = {
  CPU_HZ: 4000000,
  PSG_TICK_HZ: 125000,      // the sound chip runs on CCLK (1 MHz); a tone output flips every (period) of these ticks, noise and envelope step every 2 x period
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
    [11, 'HSYNC', 'i'], [12, 'R', 'i'], [13, 'VSYNC', 'i'], [14, 'CPU', 'i'], [15, 'VSS1', 'g'], [16, 'CAS', 'i'], [17, 'MREQ', 'i'], [18, 'IORQ', 'i'], [19, 'PHI', 'i'], [20, 'M1', 'i'],
    [21, 'RD', 'i'], [22, 'READY', 'i'], [23, '244EN', 'o'], [24, 'CK16', 'i'], [25, 'VDD2', 'p'], [26, 'VSS2', 'g'], [27, 'ROMEN', 'i'], [28, 'A15', 'i'], [29, 'RAMRD', 'i'], [30, 'A14', 'i'],
    [31, 'CASAD', 'i'], [32, 'INT', 'i'], [33, 'MWE', 'i'], [34, 'RAS', 'i'], [35, 'D0', 'i'], [36, 'VSS3', 'g'], [37, 'D1', 'i'], [38, 'D2', 'i'], [39, 'D3', 'i'], [40, 'D4', 'i']],
  '40007': [[1, 'CPU', 'i'], [2, 'READY', 'i'], [3, 'CAS', 'i'], [4, '244EN', 'o'], [5, 'MWE', 'i'], [6, 'CASAD', 'i'], [7, 'RAS', 'i'], [8, 'CK16', 'i'], [9, 'VCC2', 'p'], [10, 'INT', 'i'],
    [11, 'SYNC', 'i'], [12, 'ROMEN', 'i'], [13, 'RAMRD', 'i'], [14, 'HSYNC', 'i'], [15, 'VSYNC', 'i'], [16, 'IORQ', 'i'], [17, 'M1', 'i'], [18, 'MREQ', 'i'], [19, 'RD', 'i'], [20, 'A15', 'i'],
    [21, 'A14', 'i'], [22, 'VCC1', 'p'], [23, 'DISPEN', 'i'], [24, 'D0', 'i'], [25, 'D1', 'i'], [26, 'D2', 'i'], [27, 'D3', 'i'], [28, 'D4', 'i'], [29, 'D5', 'i'], [30, 'D6', 'i'],
    [31, 'D7', 'i'], [32, 'B', 'i'], [33, 'VCC2', 'p'], [34, 'G', 'i'], [35, 'GND', 'g'], [36, 'R', 'i'], [37, 'RESET', 'i'], [38, 'VCC1', 'p'], [39, 'PHI', 'i'], [40, 'CCLK', 'i']]
};
// HD6845 (the same pins as the MC6845). On the CPC: CS is A14, RS is A8, R/W is A9, E comes from IORQ, CLK is the gate array's CCLK.
const CPC_CRTC_PINS = [[1, 'GND', 'g'], [2, 'RESET', 'i'], [3, 'LPSTB', 'o'], ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(n => [4 + n, 'MA' + n, 'i']), [18, 'DE', 'i'], [19, 'CURSOR', 'o'], [20, 'VCC', 'p'],
  [21, 'CLK', 'i'], [22, 'R/W', 'i'], [23, 'E', 'i'], [24, 'RS', 'i'], [25, 'CS', 'i'], ...[7, 6, 5, 4, 3, 2, 1, 0].map((d, k) => [26 + k, 'D' + d, 'i']), [34, 'RA4', 'o'], [35, 'RA3', 'o'], [36, 'RA2', 'i'], [37, 'RA1', 'i'], [38, 'RA0', 'i'], [39, 'HSYNC', 'i'], [40, 'VSYNC', 'i']];
// Z80: the pins that can carry a fault (kind 'i') are the bus lines and the clock
const CPC_Z80_PINS = [[1, 'A11'], [2, 'A12'], [3, 'A13'], [4, 'A14'], [5, 'A15'], [6, 'CLK'], [7, 'D4'], [8, 'D3'], [9, 'D5'], [10, 'D6'], [11, '+5V', 'p'], [12, 'D2'], [13, 'D7'], [14, 'D0'], [15, 'D1'],
  [16, 'INT'], [17, 'NMI'], [18, 'HALT'], [19, 'MREQ'], [20, 'IORQ'], [21, 'RD'], [22, 'WR'], [23, 'BUSACK', 'o'], [24, 'WAIT'], [25, 'BUSREQ'], [26, 'RESET'], [27, 'M1'], [28, 'RFSH', 'o'], [29, 'GND', 'g'],
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => [30 + n, 'A' + n])].map(([n, name, k]) => [n, name, k || 'i']);
if (typeof MEM_PINOUTS !== 'undefined') { Object.assign(MEM_PINOUTS, CPC_GA_PINS); MEM_PINOUTS.HD6845 = CPC_CRTC_PINS; MEM_PINOUTS.Z80 = CPC_Z80_PINS; for (const n of ['SYNC', 'RESET', 'CPU', 'MREQ', 'IORQ', 'M1', 'RD', '244EN', 'ROMEN', 'RAMRD', 'CASAD', 'INT', 'MWE']) MEM_ACTIVE_LOW.add(n); }
// The 74LS153 address selectors (IC109, IC104, IC113, IC105): two 4-to-1 selectors each, sharing the select inputs
// B (the gate array's CPU, low for a CPU access) and A (CAS ADDR, low for the column). Inputs 0 and 1 take the CPU's
// column and row address bits, 2 and 3 the display address's; 1G and 2G are tied to ground (a high G turns its
// output low). CPC_SEL gives each RAM address pin its selector and half.
const CPC_SEL_PINS = [[1, '1G'], [2, 'B'], [3, '1C3'], [4, '1C2'], [5, '1C1'], [6, '1C0'], [7, '1Y'], [8, 'GND', 'g'], [9, '2Y'], [10, '2C0'], [11, '2C1'], [12, '2C2'], [13, '2C3'], [14, 'A'], [15, '2G'], [16, 'VCC', 'p']].map(([n, name, k]) => [n, name, k || 'i']);
const CPC_SEL = [['IC105', '2'], ['IC105', '1'], ['IC113', '2'], ['IC113', '1'], ['IC104', '2'], ['IC104', '1'], ['IC109', '2'], ['IC109', '1']];   // by RAM address pin
// each selector input's source: the display address's row and column bits, by RAM pin (the same bit numbers as the CPU's)
const CPC_VID_SRC = ['MA1', 'MA0', 'MA3', 'MA2', 'MA5', 'MA4', 'MA7', 'MA6'].map((r, p) => [r, ['MA8', 'CCLK', 'RA0', 'MA9', 'RA2', 'RA1', 'MA13', 'MA12'][p]]);
// The 8255 (IC107, M5L8255AP). Port A is the sound chip's data bus; port B reads VSYNC (PB0), the links (PB1-PB4),
// EXP (PB5), the printer's BUSY (PB6) and the cassette (PB7); port C selects the keyboard row (PC0-PC3, to the
// 74LS145), runs the cassette motor (PC4) and writes to the tape (PC5), and drives the sound chip's BC1 (PC6) and
// BDIR (PC7). CS is A11, A1 is A9, A0 is A8. Its RESET is active high, from the reset circuit (the inverse of the
// board's RESET line).
const CPC_PPI_PINS = [[1, 'PA3'], [2, 'PA2'], [3, 'PA1'], [4, 'PA0'], [5, 'RD'], [6, 'CS'], [7, 'GND', 'g'], [8, 'A1'], [9, 'A0'], [10, 'PC7'], [11, 'PC6'], [12, 'PC5'], [13, 'PC4'], [14, 'PC0'], [15, 'PC1'], [16, 'PC2'], [17, 'PC3'],
  [18, 'PB0'], [19, 'PB1'], [20, 'PB2'], [21, 'PB3'], [22, 'PB4'], [23, 'PB5'], [24, 'PB6'], [25, 'PB7'], [26, 'VCC', 'p'], [27, 'D7'], [28, 'D6'], [29, 'D5'], [30, 'D4'], [31, 'D3'], [32, 'D2'], [33, 'D1'], [34, 'D0'],
  [35, 'RESET'], [36, 'WR'], [37, 'PA7'], [38, 'PA6'], [39, 'PA5'], [40, 'PA4']].map(([n, name, k]) => [n, name, k || 'i']);
// The sound chip (IC102, AY-3-8912). DA0-DA7 to the 8255's port A; BDIR and BC1 from PC7 and PC6; BC2 and A8 tied
// high; CLOCK is CCLK; RESET the board's RESET line; IO0-IO7 read the keyboard's columns; A, B and C to the mixer.
const CPC_AY_PINS = [[1, 'C'], [2, 'TEST', 'o'], [3, 'VCC', 'p'], [4, 'B'], [5, 'A'], [6, 'GND', 'g'], [7, 'IO7'], [8, 'IO6'], [9, 'IO5'], [10, 'IO4'], [11, 'IO3'], [12, 'IO2'], [13, 'IO1'], [14, 'IO0'],
  [15, 'CLOCK'], [16, 'RESET'], [17, 'A8'], [18, 'BDIR'], [19, 'BC2'], [20, 'BC1'], [21, 'DA7'], [22, 'DA6'], [23, 'DA5'], [24, 'DA4'], [25, 'DA3'], [26, 'DA2'], [27, 'DA1'], [28, 'DA0']].map(([n, name, k]) => [n, name, k || 'i']);
if (typeof MEM_PINOUTS !== 'undefined') { MEM_PINOUTS['74LS153'] = CPC_SEL_PINS; MEM_PINOUTS.M5L8255AP = CPC_PPI_PINS; MEM_PINOUTS['AY-3-8912'] = CPC_AY_PINS; for (const n of ['1G', '2G', 'WR']) MEM_ACTIVE_LOW.add(n); }
// Which pins share a line. d: the pin that drives it (index into pins), or -1 when the driver is not drawn as a chip
// or several pins drive it in turn (the data bus).
const CPC_NETS = (() => {
  const N = {}, ram = n => 'IC' + CPC.RAM_ICS[n], rams = pin => CPC.RAM_ICS.map(ic => ['IC' + ic, pin]);
  for (let n = 0; n < 16; n++) N['A' + n] = { label: `address line A${n}`, d: 0, pins: [['IC111', 'A' + n], ...(n < 15 ? [['IC103', 'A' + n]] : []), ...(n >= 14 ? [['IC116', 'A' + n]] : []), ...(n === 14 ? [['IC108', 'CS']] : n === 8 ? [['IC108', 'RS']] : n === 9 ? [['IC108', 'R/W']] : [])] };
  for (let n = 0; n < 8; n++) N['D' + n] = { label: `data line D${n}`, d: -1, pins: [['IC111', 'D' + n], ['IC103', 'O' + n], [ram(n), 'DIN'], ['IC108', 'D' + n], ['IC107', 'D' + n]] };
  // the selectors' inputs, the 8255's CS, A1 and A0
  CPC.RAM_PINS.forEach(([r, c], p) => { const [ic, h] = CPC_SEL[p]; N['A' + c].pins.push([ic, h + 'C0']); N['A' + r].pins.push([ic, h + 'C1']); });
  N.A11.pins.push(['IC107', 'CS']); N.A9.pins.push(['IC107', 'A1']); N.A8.pins.push(['IC107', 'A0']);
  // the 6845's display address, to the selectors
  const vn = {}; CPC_VID_SRC.forEach(([r, c], p) => { const [ic, h] = CPC_SEL[p]; (vn[c] = vn[c] || []).push([ic, h + 'C2']); (vn[r] = vn[r] || []).push([ic, h + 'C3']); });
  for (const k in vn) if (k !== 'CCLK') N['V' + k] = { label: `display address ${k} (6845)`, d: 0, pins: [['IC108', k], ...vn[k]] };
  N.CPUAD = { label: 'CPU line (CPU ADDR, the selectors\' B)', d: 0, pins: [['IC116', 'CPU'], ...['IC109', 'IC104', 'IC113', 'IC105'].map(ic => [ic, 'B'])] };
  N.CASAD = { label: 'CAS ADDR line (the selectors\' A)', d: 0, pins: [['IC116', 'CASAD'], ...['IC109', 'IC104', 'IC113', 'IC105'].map(ic => [ic, 'A'])] };
  // the sound chip's bus, from the 8255
  for (let n = 0; n < 8; n++) N['PA' + n] = { label: `sound chip data line ${n} (8255 port A)`, d: -1, pins: [['IC107', 'PA' + n], ['IC102', 'DA' + n]] };
  N.BDIR = { label: 'BDIR line (8255 PC7)', d: 0, pins: [['IC107', 'PC7'], ['IC102', 'BDIR']] };
  N.BC1 = { label: 'BC1 line (8255 PC6)', d: 0, pins: [['IC107', 'PC6'], ['IC102', 'BC1']] };
  for (const k of ['MREQ', 'IORQ', 'M1', 'RD']) N[k] = { label: k + ' line', d: 0, pins: [['IC111', k], ['IC116', k]] };
  N.RESET = { label: 'RESET line', d: -1, pins: [['IC111', 'RESET'], ['IC116', 'RESET'], ['IC108', 'RESET'], ['IC102', 'RESET']] };
  N.INT = { label: 'INT line', d: 0, pins: [['IC116', 'INT'], ['IC111', 'INT']] };
  N.READY = { label: 'READY line (the Z80\'s WAIT)', d: 0, pins: [['IC116', 'READY'], ['IC111', 'WAIT']] };
  N.PHI = { label: '4 MHz clock PHI', d: 0, pins: [['IC116', 'PHI'], ['IC111', 'CLK']] };
  N.CCLK = { label: '1 MHz clock CCLK', d: 0, pins: [['IC116', 'CCLK'], ['IC108', 'CLK'], ['IC102', 'CLOCK'], ['IC105', '1C2']] };
  N.HSYNC = { label: 'HSYNC line', d: 0, pins: [['IC108', 'HSYNC'], ['IC116', 'HSYNC']] };
  N.VSYNC = { label: 'VSYNC line', d: 0, pins: [['IC108', 'VSYNC'], ['IC116', 'VSYNC'], ['IC107', 'PB0']] };
  N.DISPEN = { label: 'DISPEN line', d: 0, pins: [['IC108', 'DE'], ['IC116', 'DISPEN']] };
  N.ROMEN = { label: 'ROMEN line', d: 0, pins: [['IC116', 'ROMEN'], ['IC103', 'CE']] };
  N.RAS = { label: 'RAS line', d: 0, pins: [['IC116', 'RAS'], ...rams('RAS')] };
  N.CAS = { label: 'CAS line', d: 0, pins: [['IC116', 'CAS'], ...rams('CAS')] };
  N.MWE = { label: 'RAM write enable MWE', d: 0, pins: [['IC116', 'MWE'], ...rams('WE')] };
  for (let n = 0; n < 8; n++) N['RA' + n] = { label: `RAM address line ${n} (from ${CPC_SEL[n][0]})`, d: 0, pins: [[CPC_SEL[n][0], CPC_SEL[n][1] + 'Y'], ...rams('A' + n)] };
  for (let n = 0; n < 8; n++) N['RD' + n] = { label: `RAM data out, bit ${n}`, d: 0, pins: [[ram(n), 'DOUT'], ['IC116', 'D' + n]] };
  return N;
})();
const CPC_NET_OF = {}; for (const k in CPC_NETS) for (const [id, pin] of CPC_NETS[k].pins) CPC_NET_OF[id + '.' + pin] = k;
// The gate array and the 6845 as chips with pin faults, in the same shape as a MemChip so that the fault list and the pin display treat it alike.
// lv[name] is the level a faulty pin sits at (a disconnected pin floats high, except the colour outputs, which go dark); undefined = no fault.
class CPCChip {
  constructor(id, part, what, range) { Object.assign(this, { id, part, what, range, f: {} }); this.recalc(); }
  setFault(pin, v) { if (v === null || v === undefined) delete this.f[pin]; else this.f[pin] = v; this.recalc(); }
  recalc() { this.lv = {}; let n = 0; for (const k in this.f) { n++; this.lv[k] = this.f[k] === 'z' ? (this.id === 'IC116' && (k === 'R' || k === 'G' || k === 'B') ? 0 : 1) : this.f[k]; } this.faulty = n > 0; this.ramDead = 'RAS' in this.f || 'CAS' in this.f;
    // 6845 address lines held at a level
    let maAnd = 0x3FFF, maOr = 0, raAnd = 31, raOr = 0, m;
    for (const k in this.lv) { if ((m = /^MA(\d+)$/.exec(k))) { if (this.lv[k]) maOr |= 1 << +m[1]; else maAnd &= ~(1 << +m[1]); } else if ((m = /^RA(\d)$/.exec(k))) { if (this.lv[k]) raOr |= 1 << +m[1]; else raAnd &= ~(1 << +m[1]); } }
    let dAnd = 0xFF, dOr = 0;
    for (const k in this.lv) if ((m = /^D(\d)$/.exec(k))) { if (this.lv[k]) dOr |= 1 << +m[1]; else dAnd &= ~(1 << +m[1]); }
    Object.assign(this, { maAnd, maOr, raAnd, raOr, dAnd, dOr });
    if (this.onChange) this.onChange();
  }
}
function cpcCrc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; }
// Sound: the AY-3-8912 (the 8910 with one I/O port) is clocked by the gate array's CCLK, 1 MHz,
// so a tone period p gives 62,500 / p Hz. Its three square-wave channels, noise generator and envelope are computed
// sample by sample as emulated time passes (when audioRate is set), into two ring buffers the page plays: the
// stereo socket's left (A, with half of B) and right (C, with half of B); the built-in speaker gets all three.
// Without CCLK (no 16 MHz, or a fault on the CCLK line or the gate array's CCLK pin) the sound chip stands still.
const CPC_PSG_VOL = [0, 0.0078, 0.011, 0.0156, 0.0221, 0.0313, 0.0442, 0.0625, 0.0884, 0.125, 0.1768, 0.25, 0.3536, 0.5, 0.7071, 1];
// Cassette: a CDT file (the TZX format) is turned into the signal it describes, a list of stretches of tape at one
// level with their lengths in CPC clocks (TZX times are 3.5 MHz T-states; the CPC runs at 4 MHz). While Play is
// pressed and the 8255 has the motor on (port C bit 4), the tape moves with emulated time, and its level is what
// port B bit 7 reads. So the firmware's own loader, and the custom loaders of games, read it bit by bit as they
// would from a real cassette. A "stop the tape" block (a pause of 0) releases Play.
class CPCTape {
  constructor(bytes) {
    const b = bytes, sig = 'ZXTape!';
    for (let i = 0; i < 7; i++) if (b[i] !== sig.charCodeAt(i)) throw new Error('Not a CDT or TZX tape file (no ZXTape! signature)');
    let cap = 1 << 16, n = 0, dur = new Uint32Array(cap), lvl = new Uint8Array(cap), level = 0, frac = 0;
    const blocks = [], stops = new Set(), notes = [];
    const push = (t35, l) => {      // a stretch of t35 T-states (3.5 MHz) at level l
      frac += t35 * 8 / 7; const c = Math.floor(frac); frac -= c; if (!c) return;
      if (n && lvl[n - 1] === l && dur[n - 1] + c < 0xFFFFFFFF) { dur[n - 1] += c; return; }
      if (n === cap) { cap *= 2; const d2 = new Uint32Array(cap), l2 = new Uint8Array(cap); d2.set(dur); l2.set(lvl); dur = d2; lvl = l2; }
      dur[n] = c; lvl[n] = l; n++;
    };
    const pulse = t => { level ^= 1; push(t, level); };
    // a pause: 1 ms at the opposite level first, to finish the last pulse, then low (as the TZX format says)
    const pause = ms => { if (ms > 0) { level ^= 1; push(3500, level); if (ms > 1) { level = 0; push((ms - 1) * 3500, 0); } } };
    const data = (off, len, zero, one, last) => {
      for (let i = 0; i < len; i++) { const v = b[off + i], bits = i === len - 1 ? last || 8 : 8; for (let k = 0; k < bits; k++) { const t = v & (0x80 >> k) ? one : zero; pulse(t); pulse(t); } }
    };
    const w = i => b[i] | b[i + 1] << 8, w3 = i => b[i] | b[i + 1] << 8 | b[i + 2] << 16, dw = i => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
    const text = (i, len) => String.fromCharCode(...b.subarray(i, i + len)).replace(/[^\x20-\x7E]/g, ' ').trim();
    // what a data block holds: a CPC header record (sync byte 2Ch) names the file
    const what = (off, len, d = b) => {
      if (d[off] === 0x2C && len > 20) { const name = String.fromCharCode(...d.subarray(off + 1, off + 17)).replace(/[^\x20-\x7E]/g, ' ').trim(); return `header "${name || '(no name)'}" block ${d[off + 17]}`; }
      return (d[off] === 0x16 ? 'data' : 'block') + `, ${len} bytes`;
    };
    // a run of plain pulses (a recording, or a tape made from one) may hold a record in the firmware's format: a leader
    // of equal pulses (1 bits), a short pulse pair (the 0 sync bit), then bytes, each bit a pulse pair, a 1 twice as
    // long as a 0. It is kept only if every 256-byte segment's CRC checks.
    let run = null;
    const endRun = () => {
      const r = run; run = null; if (!r || r.p.length < 600) return;
      const p = r.p, found = []; let i = 0;
      while (i + 256 < p.length) {
        let L = p[i], j = i + 1, sum = L;
        while (j < p.length && Math.abs(p[j] - sum / (j - i)) < sum / (j - i) * 0.25) { sum += p[j]; j++; }
        const lead = sum / (j - i);
        if (j - i >= 256 && j + 1 < p.length && p[j] + p[j + 1] < lead * 1.5) {
          const out = []; let k = j + 2, v = 0, nb = 0;
          while (k + 1 < p.length && p[k] < lead * 2.5 && p[k + 1] < lead * 2.5) { v = v << 1 | (p[k] + p[k + 1] > lead * 1.5 ? 1 : 0); k += 2; if (++nb === 8) { out.push(v); v = 0; nb = 0; } }
          const d = new Uint8Array(out); let good = d.length >= 259;
          for (let s = 0; good && s * 258 + 258 <= d.length - 1; s++) good = CPCTape.crc(d.subarray(1 + s * 258, 257 + s * 258)) === (d[257 + s * 258] << 8 | d[258 + s * 258]);
          if (good) found.push({ data: d, i0: i, i1: k });
          i = k;
        } else i = j;
      }
      // each record found becomes a listed block (the first takes over the run's own entry); pulses map one to one to stretches of tape
      const at = blocks.indexOf(r.blk), runEnd = r.blk.end;
      found.forEach((f, q) => {
        const bl = q ? { block: r.blk.block, seg: r.seg0 + f.i0 } : r.blk;
        bl.data = f.data; bl.desc = (q ? '' : r.blk.desc.replace(/(tone and )?pulses$/, '')) + 'recorded ' + what(0, f.data.length, f.data); bl.end = q + 1 < found.length ? r.seg0 + found[q + 1].i0 : runEnd;
        if (q) blocks.splice(at + q, 0, bl);
      });
    };
    // first pass: where each block starts
    const offs = []; let i = 10;
    const size = (t, i) => {
      switch (t) {
        case 0x10: return 4 + w(i + 2); case 0x11: return 18 + w3(i + 15); case 0x12: return 4; case 0x13: return 1 + 2 * b[i];
        case 0x14: return 10 + w3(i + 7); case 0x15: return 8 + w3(i + 5); case 0x18: case 0x19: return 4 + dw(i);
        case 0x20: case 0x23: case 0x24: return 2; case 0x21: return 1 + b[i]; case 0x22: case 0x25: case 0x27: return 0;
        case 0x26: return 2 + 2 * w(i); case 0x28: return 2 + w(i); case 0x2A: return 4; case 0x2B: return 5;
        case 0x30: return 1 + b[i]; case 0x31: return 2 + b[i + 1]; case 0x32: return 2 + w(i); case 0x33: return 1 + 3 * b[i];
        case 0x35: return 20 + dw(i + 16); case 0x5A: return 9; default: return 4 + dw(i);     // later blocks start with their length
      }
    };
    while (i < b.length) { const t = b[i]; offs.push(i); i += 1 + size(t, i + 1); }
    if (i > b.length + 0) notes.push('the last block is cut short');
    // second pass: the signal
    let group = '', loopAt = -1, loopN = 0, fresh = true;     // fresh: at the start or after a pause or data block, so a run of plain pulses is listed as a block
    for (let k = 0; k < offs.length; k++) {
      const o = offs[k], t = b[o], j = o + 1; if (j >= b.length) break;
      const start = n, mark = (d, off, len) => blocks.push({ seg: start, block: k, desc: (group ? group + ': ' : '') + d, off, len });
      const wasFresh = fresh; if (t === 0x12 || t === 0x13) fresh = false; else if ([0x10, 0x11, 0x14, 0x15, 0x20].includes(t)) { fresh = true; endRun(); }
      switch (t) {
        case 0x10: { const len = w(j + 2), off = j + 4; mark('standard ' + what(off, len), off, len); for (let p = b[off] < 128 ? 8063 : 3223; p > 0; p--) pulse(2168); pulse(667); pulse(735); data(off, len, 855, 1710, 8); pause(w(j)); break; }
        case 0x11: { const len = w3(j + 15), off = j + 18; mark('turbo ' + what(off, len), off, len); for (let p = w(j + 10); p > 0; p--) pulse(w(j)); pulse(w(j + 2)); pulse(w(j + 4)); data(off, len, w(j + 6), w(j + 8), b[j + 12]); pause(w(j + 13)); break; }
        case 0x12: { if (wasFresh) { mark('tone and pulses'); run = { p: [], blk: blocks[blocks.length - 1], seg0: n }; } for (let p = w(j + 2); p > 0; p--) { pulse(w(j)); if (run) run.p.push(w(j)); } break; }
        case 0x13: { if (wasFresh) { mark('pulses'); run = { p: [], blk: blocks[blocks.length - 1], seg0: n }; } for (let p = 0; p < b[j]; p++) { pulse(w(j + 1 + 2 * p)); if (run) run.p.push(w(j + 1 + 2 * p)); } break; }
        case 0x14: { const len = w3(j + 7), off = j + 10; mark('pure ' + what(off, len), off, len); data(off, len, w(j), w(j + 2), b[j + 4]); pause(w(j + 5)); break; }
        case 0x15: { const tps = w(j), len = w3(j + 5), off = j + 8, last = b[j + 4] || 8; mark(`direct recording, ${len} bytes`);
          for (let q = 0; q < len; q++) for (let r = 0; r < (q === len - 1 ? last : 8); r++) { level = b[off + q] & (0x80 >> r) ? 1 : 0; push(tps, level); }
          pause(w(j + 2)); break; }
        case 0x20: { const ms = w(j); if (ms) pause(ms); else { stops.add(n); mark('stop the tape'); } break; }
        case 0x21: group = text(j + 1, b[j]); break;
        case 0x22: group = ''; break;
        case 0x23: { const rel = (w(j) << 16) >> 16; if (rel) k += rel - 1; break; }
        case 0x24: loopAt = k; loopN = w(j); break;
        case 0x25: if (loopAt >= 0 && --loopN > 0) k = loopAt; else loopAt = -1; break;
        case 0x2B: level = b[j + 4] ? 1 : 0; break;
        case 0x30: notes.push(text(j + 1, b[j])); break;
        case 0x18: case 0x19: notes.push(`block type ${t.toString(16).toUpperCase()}h is not supported and was skipped`); break;
        default: break;      // information only, or not needed for a CPC
      }
      const lb = blocks[blocks.length - 1]; if (lb && lb.block === k) lb.end = n;
      if (run && lb) lb.end = n;
    }
    endRun();
    this.bytes = b; for (const bl of blocks) if (bl.off !== undefined) bl.data = b.subarray(bl.off, bl.off + bl.len);
    for (let q = 0; q < blocks.length; q++) if (blocks[q].end === undefined || blocks[q].end < blocks[q].seg) blocks[q].end = q + 1 < blocks.length ? blocks[q + 1].seg : n;
    this.dur = dur.subarray(0, n); this.lvl = lvl.subarray(0, n); this.n = n; this.blocks = blocks; this.stops = stops; this.notes = notes;
    this.total = 0; for (let q = 0; q < n; q++) this.total += this.dur[q];
  }
}
// A recording as a CDT file: the pulses (in CPC clocks) as TZX pulse-sequence blocks, at 3.5 MHz T-states; a gap
// longer than a pulse can be becomes a pause block. Returns null if nothing was recorded.
// the firmware's CRC of a 256-byte segment: CCITT (polynomial 1021h) from FFFFh, inverted
CPCTape.crc = seg => { let c = 0xFFFF; for (const v of seg) { c ^= v << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return ~c & 0xFFFF; };
CPCTape.fromPulses = (pulses, note = 'Recorded on the Z80 Bench Amstrad CPC 464 emulator') => {
  const out = [...'ZXTape!'].map(c => c.charCodeAt(0)).concat([0x1A, 1, 20]);
  const t = [...note].map(c => c.charCodeAt(0) & 0x7F).slice(0, 255); out.push(0x30, t.length, ...t);
  let run = [], frac = 0, any = false;
  const flush = () => { while (run.length) { const n = Math.min(255, run.length); out.push(0x13, n); for (const v of run.splice(0, n)) out.push(v & 255, v >> 8); } };
  for (let i = 0; i < pulses.length; i++) {
    frac += pulses[i] * 7 / 8; const v = Math.round(frac); frac -= v;
    if (i === 0 && v > 65535) continue;                    // silence before the first edge
    if (v > 65535) { flush(); const ms = Math.min(65535, Math.max(1, Math.round(v / 3500))); out.push(0x20, ms & 255, ms >> 8); continue; }
    if (v > 0) { run.push(v); any = true; }
  }
  flush();
  return any ? new Uint8Array(out) : null;
};
// Tapes from WAV files: a recording of a real cassette (or of a tape made by an emulator) is turned into the pulses it
// carries, and those into a CDT file, so it plays exactly like one, with the firmware's records found for instant
// loading. The samples (8, 16, 24 or 32-bit PCM, or float; the channels averaged) are freed of any DC drift by taking
// away their average over 3 ms; the level then flips only when the signal swings past a threshold that follows its own
// loudness (a quarter of the recent peak), and never below a floor set from the file itself: twice the hiss (the peak
// level of the quietest tenth of its 5 ms stretches), at least 3% and at most 40% of the signal (the loudest tenth), so
// hiss in the gaps is ignored. Each edge is timed at the zero crossing before the flip, between samples, and the time between edges
// becomes a pulse in CPC clocks.
CPCTape.readWav = bytes => {
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = i => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file (no RIFF WAVE header)');
  let fmt = null, data = null;
  for (let i = 12; i + 8 <= b.length;) {
    const id = tag(i), len = dv.getUint32(i + 4, true), body = i + 8;
    if (id === 'fmt ') { let f = dv.getUint16(body, true); const bits = dv.getUint16(body + 14, true); if (f === 0xFFFE && len >= 26) f = dv.getUint16(body + 24, true); fmt = { f, ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), align: dv.getUint16(body + 12, true), bits }; }
    else if (id === 'data') data = [body, Math.min(len, b.length - body)];
    i = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('The WAV file has no ' + (fmt ? 'sound data' : 'format chunk'));
  const { f, ch, rate, align, bits } = fmt, by = bits >> 3;
  if (!(f === 1 && [8, 16, 24, 32].includes(bits) || f === 3 && (bits === 32 || bits === 64)) || !ch || !rate || align < ch * by) throw new Error(`WAV format not supported (format ${f}, ${bits} bits): use PCM or float`);
  const n = Math.floor(data[1] / align), x = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) {
      const o = data[0] + k * align + c * by;
      sum += f === 3 ? (bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true)) : bits === 8 ? (b[o] - 128) / 128 : bits === 16 ? dv.getInt16(o, true) / 32768 : bits === 24 ? ((b[o] | b[o + 1] << 8 | b[o + 2] << 16) << 8 >> 8) / 8388608 : dv.getInt32(o, true) / 2147483648;
    }
    x[k] = sum / ch;
  }
  return { rate, x, bits, ch };
};
CPCTape.wavPulses = (x, rate) => {
  const n = x.length, W = Math.max(3, Math.round(rate * 0.003)), y = new Float32Array(n);
  let acc = 0; const half = W >> 1;                                        // centred moving average
  for (let k = 0; k < Math.min(n, half); k++) acc += x[k];
  for (let k = 0; k < n; k++) {
    const add = k + half, sub = k - half - 1; if (add < n) acc += x[add]; if (sub >= 0) acc -= x[sub];
    const cnt = Math.min(n - 1, k + half) - Math.max(0, k - half) + 1; y[k] = x[k] - acc / cnt;
  }
  // the noise floor: the peak of each 5 ms window; the quietest tenth of them is the hiss, the loudest tenth the signal
  const Wn = Math.max(8, Math.round(rate * 0.005)), wp = [];
  for (let k = 0; k < n; k += Wn) { let m = 0; for (let j = k; j < Math.min(n, k + Wn); j++) m = Math.max(m, Math.abs(y[j])); wp.push(m); }
  wp.sort((p, q) => p - q);
  const sig = wp[Math.floor(wp.length * 0.9)] || 0, hiss = wp[Math.floor(wp.length * 0.1)] || 0;
  if (!sig) return [];
  const floor = Math.min(sig * 0.4, Math.max(sig * 0.03, hiss * 2)), decay = Math.exp(-1 / (rate * 0.02)), pulses = [], clk = 4000000 / rate;
  let env = 0, state = 0, cross = 0, last = 0, first = true;
  for (let k = 1; k < n; k++) {
    const v = y[k], a = Math.abs(v); env = Math.max(a, env * decay);
    if ((v >= 0) !== (y[k - 1] >= 0)) cross = k - 1 + y[k - 1] / (y[k - 1] - v);   // the zero crossing, between samples
    const h = Math.max(floor, env * 0.25);
    if (state <= 0 && v > h || state >= 0 && v < -h) {
      const want = v > 0 ? 1 : -1;
      if (state !== want) { if (state !== 0) { pulses.push(Math.max(1, Math.round((cross - last) * clk))); } else if (first) { pulses.push(Math.max(1, Math.round(cross * clk))); first = false; } last = cross; state = want; }
    }
  }
  return pulses;
};
CPCTape.fromWav = (bytes, name) => {
  const w = CPCTape.readWav(bytes), pulses = CPCTape.wavPulses(w.x, w.rate);
  const t = CPCTape.fromPulses(pulses, `Converted from ${name || 'a WAV file'} (${w.rate} Hz, ${w.bits}-bit, ${w.ch === 1 ? 'mono' : w.ch + ' channels'}) by Z80 Bench`);
  if (!t) throw new Error('No tape signal was found in the WAV file');
  return t;
};
// a tape's signal as a WAV file (mono, 8-bit by default), for testing and for playing into a real CPC
CPCTape.toWav = (tape, rate = 44100, opt = {}) => {
  let total = 0; for (let i = 0; i < tape.n; i++) total += tape.dur[i];
  const n = Math.ceil(total / 4000000 * rate) + 1, bits = opt.bits || 8, by = bits >> 3, out = new Uint8Array(44 + n * by), dv = new DataView(out.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * by, true); put(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * by, true); dv.setUint16(32, by, true); dv.setUint16(34, bits, true); put(36, 'data'); dv.setUint32(40, n * by, true);
  const amp = opt.amp === undefined ? 0.8 : opt.amp, rc = opt.smooth ? Math.exp(-1 / opt.smooth) : 0, dc = opt.dc || 0, hiss = opt.noise || 0, inv = opt.invert ? -1 : 1;
  let seg = 0, left = tape.n ? tape.dur[0] : Infinity, t = 0, v = 0, seed = 12345;
  for (let k = 0; k < n; k++) {
    const at = (k / rate) * 4000000; while (seg < tape.n && at - t >= left) { t += left; seg++; left = seg < tape.n ? tape.dur[seg] : Infinity; }
    const target = seg < tape.n ? (tape.lvl[seg] ? amp : -amp) * inv : 0;
    v = rc ? v * rc + target * (1 - rc) : target;
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    const s = Math.max(-1, Math.min(1, v + dc + hiss * (seed / 0x7FFFFFFF * 2 - 1)));
    if (bits === 8) out[44 + k] = Math.round(s * 127 + 128); else dv.setInt16(44 + k * 2, Math.round(s * 32767), true);
  }
  return out;
};
class CPCMachine {
  constructor() {
    this.rom = new Uint8Array(0x8000).fill(0xFF); this.hasLo = false; this.hasHi = false;
    this.ram = new Uint8Array(0x10000);
    this.romChip = new MemChip('IC103', '23256', 'ROM: firmware (lower half) and BASIC (upper half)', '0000h-3FFFh and C000h-FFFFh', this.rom, 0, 15, { rom: true });
    const amap = CPC.RAM_PINS.map(([r, c]) => (1 << r) | (1 << c));
    this.ramBank = CPC.RAM_ICS.map((ic, bit) => new MemChip('IC' + ic, '4164', `RAM, data bit ${bit}`, '0000h-FFFFh', this.ram, 0, 16, { dram: true, bit, mux: 8, amap }));
    this.ga = new CPCChip('IC116', '40010', 'gate array: clocks, memory control, interrupts and video', 'port 7Fxxh (write only)');
    this.vdu = new CPCChip('IC108', 'HD6845', '6845 video controller: display address and sync timing', 'ports BCxxh-BFxxh');
    this.z80 = new CPCChip('IC111', 'Z80', 'processor: a fault on a bus pin here is a fault on that line, for every chip', 'address, data and control lines');
    const selWhat = p => { const [r1, c1] = CPC.RAM_PINS[p], [r2, c2] = CPC.RAM_PINS[p - 1]; return `RAM address selector: RAM A${p} (A${r1}/A${c1}) and A${p - 1} (A${r2}/A${c2}), or the display address`; };
    this.sel = [['IC109', 7], ['IC104', 5], ['IC113', 3], ['IC105', 1]].map(([ic, p]) => new CPCChip(ic, '74LS153', selWhat(p), 'RAM address lines A' + (p - 1) + ' and A' + p));
    this.ppi = new CPCChip('IC107', 'M5L8255AP', '8255 I/O: keyboard row, cassette, the sound chip\'s bus, and VSYNC and the links', 'ports F4xxh-F7xxh');
    this.ay = new CPCChip('IC102', 'AY-3-8912', 'sound chip: three channels, noise and envelope; its I/O port reads the keyboard', 'through the 8255 (port A, PC6 and PC7)');
    this.chips = [this.romChip, ...this.ramBank, this.ga, this.vdu, this.z80, ...this.sel, this.ppi, this.ay];
    this.pinF = {}; this.netF = {};
    for (const c of [this.ga, this.vdu, this.z80, ...this.sel, this.ppi, this.ay]) c.onChange = () => this.refault();
    this.refault();
    this.banks = [[this.romChip], this.ramBank];
    this.chipById = {}; for (const c of this.chips) this.chipById[c.id] = c;
    this.faulty = false;
    this.acc = new Uint32Array(5);                    // accesses: 0 ROM, 1 RAM, 2 writes to the gate array, 3 the 8255, 4 the sound chip
    this.crtc = new Uint8Array(18); this.crtcSel = 0;
    this.psg = new Uint8Array(16); this.keys = new Uint8Array(10);      // keys: bit set = key down
    this.rec = null; this.instant = false;     // instant: records the firmware reads come straight from the tape file (see casTrap)
    this.rec = null;     // a recording: { pulses: clocks between edges, clock: tape time while recording, last: time of the last edge, level }
    this.tape = null; this.tapePlay = false; this.tapeIdx = 0; this.tapeRem = 0; this.tapeLevel = 0; this.tapePos = 0;
    this.audioRate = 0; this.abufL = new Float32Array(32768); this.abufR = new Float32Array(32768); this.aw = 0; this.audioT = 0;
    this.pens = new Uint8Array(17);                   // gate array colours for pens 0-15 and the border
    this.fb = new Uint8Array(CPC.FW * CPC.FH).fill(20);   // the picture, as gate array colour numbers
    this.bus = { read: a => this.read(a), write: (a, v) => this.write(a, v), input: p => this.input(p), output: (p, v) => this.output(p, v) };
    this.cpu = new Z80(this.bus); this.cpu.log = true; this.cpu.intVector = 0xFF;
    // a held processor (no clock, or READY low) does nothing for one character: the video still gets its time
    const run = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => {
      const why = this.heldWhy; if (!why) { this.zr = false; return run(); }
      if (!this.zr && this.z80.lv.RESET === 0) { this.cpu.reset(); this.zr = true; }     // held in reset by its own pin
      this.cpu.lastEvent = null; return [{ k: 'ID', n: 4, held: why }];
    };
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
  // the RESET line goes low: every chip resets, unless its own RESET pin is held high or disconnected
  chipReset() {
    if (this.z80.lv.RESET !== 1) this.cpu.reset();
    if (this.ga.lv.RESET !== 1) { this.gaMode = 0; this.gaPen = 0; this.intCnt = 0; this.intReq = false; this.vsDelay = 0; }
    if (this.vdu.lv.RESET !== 1) { this.hcc = 0; this.vcc = 0; this.vlc = 0; this.adj = -1; this.maRow = 0; this.vde = true; this.hs = false; this.hsw = 0; this.vsw = 0; this.de = false; this.vsync = false; this.line = 0; }
    if (!('RESET' in this.ppi.lv)) { this.ppiA = 0; this.ppiC = 0; this.ppiCtl = 0x9B; }    // the 8255's own (active-high) reset, unless its pin has a fault
    this.printer = 0; this.romSel = 0;
    if (this.ay.lv.RESET !== 1) { this.psg.fill(0); this.psgSel = 0; this.toneCnt = [0, 0, 0]; this.toneOut = [0, 0, 0]; this.noiseCnt = 0; this.lfsr = 1; this.envCnt = 0; this.envPos = 0; }   // the sound chip's RESET is on the line too
    this.cpu.intLine = false;
  }
  // a reset from the bench: the RESET line, and the bench's own clocks and counters back to zero
  reset() {
    this.t = 0; this.vt = 0; this.frames = 0; this.ints = 0;
    this.vmode = 0; this.gHs = false; this.gVs = false; this.mx = 0; this.my = 0; this.pictures = 0; this.rgb = 20;
    this.waits = 0; this.ramBus = 0xFF; this.vlN = 0;
    this.chipReset();
  }
  // ---- memory ----
  // ---- the two kinds of fault ----
  netOf(id, pin) { return CPC_NET_OF[id + '.' + pin] || null; }
  isDriver(id, pin) { const n = CPC_NETS[this.netOf(id, pin)]; if (!n) return false; return n.d >= 0 && n.pins[n.d][0] === id && n.pins[n.d][1] === pin; }
  // v: 'z' disconnected from its line (floating), 0 or 1 disconnected and at that level, null to reconnect. id 'net' sets a line.
  setPinFault(id, pin, v) { if (id === 'net') return this.setNetFault(pin, v); const k = id + '.' + pin; if (v === null || v === undefined) delete this.pinF[k]; else this.pinF[k] = v; this.applyFaults(); }
  // a whole line held at 0 or 1 (null to release it)
  setNetFault(net, v) { if (v === null || v === undefined) delete this.netF[net]; else this.netF[net] = v; this.applyFaults(); }
  clearFaults() { this.pinF = {}; this.netF = {}; this.applyFaults(); }
  // one chip back to normal: its disconnected pins, and (unless pinsOnly) the held lines its pins are on
  clearChip(id, pinsOnly) {
    for (const k of Object.keys(this.pinF)) if (k.startsWith(id + '.')) delete this.pinF[k];
    if (!pinsOnly) for (const net of Object.keys(this.netF)) if (CPC_NETS[net].pins.some(p => p[0] === id)) delete this.netF[net];
    this.applyFaults();
  }
  applyFaults() {
    const f = {}; for (const c of this.chips) f[c.id] = {};
    for (const net in this.netF) for (const [id, pin] of CPC_NETS[net].pins) f[id][pin] = this.netF[net];
    for (const k in this.pinF) {                                                 // an output cut off from its line, or stuck: the pins that listen see the line float, or the level
      const [id, pin] = k.split('.'), net = CPC_NET_OF[k], N = net && CPC_NETS[net];
      if (N && !(net in this.netF) && N.d >= 0 && N.pins[N.d][0] === id && N.pins[N.d][1] === pin) for (const [i2, p2] of N.pins) if (i2 !== id || p2 !== pin) f[i2][p2] = this.pinF[k];
    }
    for (const k in this.pinF) { const [id, pin] = k.split('.'); f[id][pin] = this.pinF[k]; }
    for (const c of this.chips) { c.f = f[c.id]; c.recalc(); }
    for (const b of this.banks) memBankFlag(b);
    this.faulty = this.chips.some(c => c.faulty);
  }
  // the faults as set, for lists: [id, pin, text]; a line has id 'net'
  faultList() {
    const out = [];
    for (const net in this.netF) out.push(['net', net, `${CPC_NETS[net].label} held ${this.netF[net] ? 'high' : 'low'} (${CPC_NETS[net].pins.length} pins)`]);
    for (const k in this.pinF) { const [id, pin] = k.split('.'), v = this.pinF[k], shared = CPC_NET_OF[k] && CPC_NETS[CPC_NET_OF[k]].pins.length > 1; out.push([id, pin, `${id} pin ${pin} ${shared ? 'disconnected from its line' + (v === 'z' ? '' : v ? ', at high' : ', at low') : v === 'z' ? 'disconnected' : v ? 'stuck high' : 'stuck low'}`]); }
    return out;
  }
  // the same for one chip's caption
  chipFaults(id) {
    const out = [];
    for (const k in this.pinF) if (k.startsWith(id + '.')) { const v = this.pinF[k]; out.push(k.slice(id.length + 1) + (v === 'z' ? ' disconnected' : v ? ' disconnected, high' : ' disconnected, low')); }
    for (const net in this.netF) for (const [i2, pin] of CPC_NETS[net].pins) if (i2 === id && !((id + '.' + pin) in this.pinF)) out.push(`${pin}: line held ${this.netF[net] ? 'high' : 'low'}`);
    return out;
  }
  // Faults changed. Work out the bus lines held at a level (faults on the Z80's pins) and each chip's view of them:
  // gv is the gate array's view (the bus-level faults on the control lines it listens to, then its own pin faults).
  refault() {
    const z = this.z80.lv, g = this.ga.lv; let aAnd = 0xFFFF, aOr = 0, m;
    for (const k in z) if ((m = /^A(\d+)$/.exec(k))) { if (z[k]) aOr |= 1 << +m[1]; else aAnd &= ~(1 << +m[1]); }
    Object.assign(this, { bAAnd: aAnd, bAOr: aOr, bDAnd: this.z80.dAnd, bDOr: this.z80.dOr, busF: this.z80.faulty });
    const gv = {}; for (const k of ['MREQ', 'IORQ', 'M1', 'RD']) if (k in z) gv[k] = z[k];
    Object.assign(gv, g); this.gv = gv; this.gf = Object.keys(gv).length > 0;
    this.gDAnd = this.ga.dAnd; this.gDOr = this.ga.dOr;
    this.ga.ramDead = 'RAS' in g || 'CAS' in g;
    // what the Z80 sees on WAIT: its own pin, else the gate array's READY output
    this.rdy = z.WAIT !== undefined ? z.WAIT : g.READY;
    this.heldWhy = 'CK16' in gv ? 'no clock: the gate array has no 16 MHz' : 'PHI' in gv ? 'no clock: PHI does not reach the Z80' : 'CLK' in z ? 'no clock at the Z80\'s CLK pin'
      : z.RESET === 0 ? 'RESET is low at the Z80: it is held in reset' : z.BUSREQ === 0 ? 'BUSREQ is low at the Z80: it has released the bus'
      : this.rdy === 0 ? (g.READY === 0 ? 'READY is low: the Z80 waits' : 'WAIT is low at the Z80: it waits') : null;
    // the selectors: any fault but on an output (those reach the RAM's address pins, which handle them)
    this.selF = this.sel.some(c => Object.keys(c.lv).some(k => k !== '1Y' && k !== '2Y'));
    // the 8255 and the sound chip: masks for their port and data pins
    const mask = (L, pre, n = 8) => { let and = 0xFF, or = 0; for (let i = 0; i < n; i++) { const v = L[pre + i]; if (v === 1) or |= 1 << i; else if (v === 0) and &= ~(1 << i); } return [and, or]; };
    const P = this.ppi.lv, Y = this.ay.lv;
    this.ppiF = this.ppi.faulty; this.ppiHeld = P.RESET === 1;                 // RESET high (or floating): the 8255 is held in reset
    [this.paAnd, this.paOr] = mask(P, 'PA'); [this.pbAnd, this.pbOr] = mask(P, 'PB'); [this.pcAnd, this.pcOr] = mask(P, 'PC');
    this.ayF = this.ay.faulty; [this.daAnd, this.daOr] = mask(Y, 'DA'); [this.ioAnd, this.ioOr] = mask(Y, 'IO');
    if (this.ayF && Y.RESET === 0) { this.psg.fill(0); this.psgSel = 0; }    // held in reset
    if (z.NMI === 0 && !this.nmiLow) this.cpu.nmiPending = true;                 // the pin going low is one falling edge
    this.nmiLow = z.NMI === 0;
  }
  // an address or data byte as it stands on the bus lines
  busA(a) { return this.busF ? a & this.bAAnd | this.bAOr : a; }
  busD(v) { return this.busF ? v & this.bDAnd | this.bDOr : v; }
  // the address as the gate array sees it on its A15 and A14 pins
  gaView(a) { const g = this.gv; if (g.A15 !== undefined) a = g.A15 ? a | 0x8000 : a & 0x7FFF; if (g.A14 !== undefined) a = g.A14 ? a | 0x4000 : a & 0xBFFF; return a; }
  romOn(a) { if (this.gf) a = this.gaView(a); return a < 0x4000 ? !(this.gaMode & 4) : a >= 0xC000 && !(this.gaMode & 8); }
  gaDead() { return this.gf && 'CK16' in this.ga.f; }
  // why the Z80 cannot run, or null (worked out in refault)
  held() { return this.heldWhy; }
  // READY held high: is the bus cycle now being run out of step with the gate array's RAM cycle?
  outOfStep() {
    if (this.rdy !== 1) return false;
    let t = this.t; for (const c of this.cpu.cyc) t += c.k === 'ID' ? c.n : c.k === 'IA' ? 6 : c.k === 'M1' || c.k === 'IR' || c.k === 'IW' ? 4 : 3;
    return ((t + 1) & 3) !== 1;
  }
  romAddr(a) { return a & 0x7FFF; }
  mem(a, quiet) {
    const f = this.faulty, g = f && this.gf ? this.gv : null, romSel = this.romOn(a);
    if (!g) {
      if (romSel) {
        const hi = a >= 0xC000; if (!quiet) this.acc[0]++;
        if (!(hi ? this.hasHi : this.hasLo)) return 0xFF;                         // nothing in that half: the bus floats high
        return f && this.romChip.faulty ? memBankRead(this.banks[0], this.romAddr(a), quiet) : this.rom[this.romAddr(a)];
      }
      if (!quiet) this.acc[1]++;
      const ra = f && this.selF ? this.selCpu(a, quiet) : a;
      let v = f && this.ramBank.faulty ? memBankRead(this.ramBank, ra, quiet) : this.ram[ra];
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
    if (ramDrive) { if (!quiet) this.acc[1]++; if (!quiet && this.outOfStep()) v &= this.ramBus; else { const r = this.ramRead(this.selF ? this.selCpu(a, quiet) : a, quiet); if (!quiet) this.ramBus = r; v &= r; } }
    if (!quiet && g.IORQ === 0 && (this.gaView(a) & 0xC000) === 0x4000) this.gaWrite(v);   // IORQ seen low all the time: memory cycles at 4000h-7FFFh look like writes to the gate array
    return v;
  }
  // the RAM's data outputs for an address, through any chip faults; with RAS or CAS missing the chips never answer
  ramRead(a, quiet) {
    if (this.gf) { if (this.ga.ramDead) return 0xFF; if (this.gv.MWE === 0) { if (!quiet) this.ram[a] = 0xFF; return 0xFF; } }   // write enable held low: every access is a write
    return this.ramBank.faulty ? memBankRead(this.ramBank, a, quiet) : this.ram[a];
  }
  // ---- the address selectors with faults: the row and column each RAM address pin gets, from the CPU's address and
  // the display address (the last one of each, for a select input held the wrong way)
  selCpu(a, quiet) { if (!quiet) this.lastCpuA = a; return this.selMap(a, this.lastVid || 0, 0); }
  selVid(v) { this.lastVid = v; return this.selMap(this.lastCpuA || 0, v, 1); }
  selMap(cpuA, vidA, video) {
    let out = 0;
    for (let p = 0; p < 8; p++) {
      const [ic, h] = CPC_SEL[p], [r, c] = CPC.RAM_PINS[p], L = this.chipById[ic].lv;
      if (L[h + 'G'] === 1) continue;                                             // enable high: the output is low
      const B = L.B !== undefined ? L.B : video;
      for (const [ph, bit] of [[1, r], [0, c]]) {                                 // row (CAS ADDR high), then column
        const k = B * 2 + (L.A !== undefined ? L.A : ph), f = L[h + 'C' + k];
        const v = f !== undefined ? f : ((k < 2 ? cpuA : vidA) >> (k & 1 ? r : c)) & 1;
        out |= v << bit;
      }
    }
    return out;
  }
  read(a) { const v = this.busF ? this.busD(this.mem(this.busA(a), false)) : this.mem(a, false); return this.ppiF && this.ppi.lv.RD === 0 && this.ppiCS(this.busA(a)) ? v & this.ppiRead(this.busA(a), true) : v; }   // the 8255's RD held low: it drives the bus on every read while selected
  peek(a) { return this.busF ? this.busD(this.mem(this.busA(a), true)) : this.mem(a, true); }
  peekW(a) { return this.peek(a) | this.peek((a + 1) & 0xFFFF) << 8; }
  write(a, v) {
    if (this.busF) { a = this.busA(a); v = this.busD(v); }
    this.acc[1]++;
    if (this.faulty && this.gf) {
      const g = this.gv;
      if (g.IORQ === 0 && (this.gaView(a) & 0xC000) === 0x4000) this.gaWrite(v);
      // no write enable: the gate array is stopped, never sees MREQ, sees RD low all the time, or the cycle is out of step
      if (this.ga.ramDead || g.MWE === 1 || 'CK16' in g || g.MREQ === 1 || g.RD === 0 || this.outOfStep()) return;
    }
    if (this.faulty) {
      if (this.ppiF && this.ppi.lv.WR === 0 && this.ppiCS(a)) this.ppiWrite(a, v);          // the 8255's WR held low: it takes every write while it is selected
      if (this.selF) a = this.selCpu(a, false);
      if (this.ramBank.faulty) { memBankWrite(this.ramBank, a, v); return; }
    }
    this.ram[a] = v;
  }
  // ---- I/O ----
  // the 8255's port C and port A as they stand on its pins: the latches, through any pin faults; held in reset, its
  // ports are inputs and the lines float high. Port A drives the sound chip's bus only while it is an output.
  ppiCout() { return this.ppiF ? (this.ppiHeld ? 0xFF : this.ppiC) & this.pcAnd | this.pcOr : this.ppiC; }
  ppiAout() { const v = this.ppiHeld || this.ppiCtl & 0x10 ? 0xFF : this.ppiA; return this.ppiF ? v & this.paAnd | this.paOr : v; }
  // the sound chip's bus control (BDIR, BC2, BC1): 'addr', 'write', 'read' or null. BC2 and A8 are tied high.
  ayMode() {
    if (!this.ayF) { const m = this.ppiCout() >> 6; return m === 3 ? 'addr' : m === 2 ? 'write' : m === 1 ? 'read' : null; }
    const Y = this.ay.lv, pc = this.ppiCout();
    if (Y.A8 === 0 || Y.RESET === 0) return null;                                 // not selected, or held in reset
    const m = (Y.BDIR !== undefined ? Y.BDIR : pc >> 7 & 1) << 2 | (Y.BC2 !== undefined ? Y.BC2 : 1) << 1 | (Y.BC1 !== undefined ? Y.BC1 : pc >> 6 & 1);
    return m === 1 || m === 4 || m === 7 ? 'addr' : m === 6 ? 'write' : m === 3 ? 'read' : null;
  }
  psgBus() {                                           // PPI port C bits 7-6 are the sound chip's BDIR and BC1
    const mode = this.ayMode(); if (!mode || mode === 'read') return;
    let d = this.ppiAout(); if (this.ayF) d = d & this.daAnd | this.daOr;
    this.acc[4]++;
    if (mode === 'addr') this.psgSel = d & 15;                                    // latch address
    else { this.psg[this.psgSel] = d; if (this.psgSel === 13) { this.envPos = 0; this.envCnt = 0; } }   // write; writing the envelope shape restarts it
  }
  // what the sound chip puts on its bus while BDIR, BC2, BC1 say read: a register, or (14) its I/O port, the keyboard's columns
  psgRead() {
    if (this.ayMode() !== 'read') return 0xFF;
    let v = this.psgSel === 14 ? this.keyRow() : this.psg[this.psgSel];
    if (this.ayF) { if (this.psgSel === 14) v = v & this.ioAnd | this.ioOr; v = v & this.daAnd | this.daOr; }
    return v;
  }
  keyRow() { const r = this.ppiCout() & 15; return r < 10 ? ~this.keys[r] & 0xFF : 0xFF; }
  // ---- the 8255. Selected by A11 low; A9 and A8 pick the port. Its CS, A1 and A0 pins can carry faults.
  ppiCS(p) { const P = this.ppi.lv; return (P.CS !== undefined ? P.CS : p >> 11 & 1) === 0; }
  ppiPort(p) { if (!this.ppiF) return p >> 8 & 3; const P = this.ppi.lv; return (P.A1 !== undefined ? P.A1 : p >> 9 & 1) << 1 | (P.A0 !== undefined ? P.A0 : p >> 8 & 1); }
  ppiRead(p, quiet) {
    if (this.ppiHeld || (this.ppiF && this.ppi.lv.RD === 1)) return 0xFF;
    if (!quiet) this.acc[3]++;
    let v = 0xFF;
    switch (this.ppiPort(p)) {
      case 0: v = this.ppiCtl & 0x10 ? this.psgRead() : this.ppiA; if (this.ppiF) v = v & this.paAnd | this.paOr; break;
      // port B: bit 0 VSYNC, bits 3-1 maker links (111 Amstrad), bit 4 50 Hz link, bit 5 expansion (high: none),
      // bit 6 printer busy (high: no printer), bit 7 cassette data in
      case 1: v = 0x7E | (this.vsOut() ? 1 : 0) | (this.tapeIn() ? 0x80 : 0); if (this.ppiF) v = v & this.pbAnd | this.pbOr; break;
      case 2: v = this.ppiC; break;
    }
    return this.ppiF ? v & this.ppi.dAnd | this.ppi.dOr : v;
  }
  ppiWrite(p, v) {
    if (this.ppiHeld || (this.ppiF && this.ppi.lv.WR === 1)) return;
    this.acc[3]++; if (this.ppiF) v = v & this.ppi.dAnd | this.ppi.dOr;
    switch (this.ppiPort(p)) {
      case 0: this.ppiA = v; this.psgBus(); break;
      case 1: break;                                                              // port B is an input
      case 2: this.ppiC = v; this.psgBus(); this.recEdge(); break;
      case 3:
        if (v & 0x80) { this.ppiCtl = v; this.ppiA = 0; this.ppiC = 0; }
        else { const b = 1 << (v >> 1 & 7); this.ppiC = v & 1 ? this.ppiC | b : this.ppiC & ~b; this.psgBus(); }
        this.recEdge();
        break;
    }
  }
  // the 6845's select pins: CS is A14, RS is A8, R/W is A9, E follows IORQ; its own pin faults override the bus
  vduBus(p) {
    const c = this.vdu.lv; if ('E' in c || this.z80.lv.IORQ === 1) return null;
    if (c.CS !== undefined ? c.CS : p >> 14 & 1) return null;
    return { rs: c.RS !== undefined ? c.RS : p >> 8 & 1, rw: c['R/W'] !== undefined ? c['R/W'] : p >> 9 & 1 };
  }
  input(p) {
    const z = this.z80.lv; if (this.busF) p = this.busA(p);
    let v = 0xFF;
    if (z.IORQ === 1) return this.busD(v);                                        // IORQ never goes low: no device answers
    const s = this.vduBus(p);
    if (s && s.rw && s.rs) v &= (this.crtcSel < 18 && this.crtcSel >= 12 ? this.crtc[this.crtcSel] : 0) & this.vdu.dAnd | this.vdu.dOr;   // 6845 read: only R12-R17 read back
    if (z.RD !== 1 && (this.ppiF ? this.ppiCS(p) : !(p & 0x0800))) v &= this.ppiRead(p);
    return this.busD(v);
  }
  output(p, v) {
    const z = this.z80.lv; if (this.busF) { p = this.busA(p); v = this.busD(v); }
    if (this.gf) {                              // the gate array through its pin faults
      const g = this.gv;
      if (g.M1 === 0) { this.intCnt &= 31; this.intReq = false; }               // M1 seen low: every I/O cycle looks like an interrupt acknowledge
      if ((this.gaView(p) & 0xC000) === 0x4000 && g.IORQ !== 1 && g.M1 !== 0) this.gaWrite(v);
    } else if (!(p & 0x8000) && p & 0x4000) this.gaWrite(v);
    const s = this.vduBus(p);                          // 6845
    if (s && !s.rw) { const d = v & this.vdu.dAnd | this.vdu.dOr; if (!s.rs) this.crtcSel = d & 31; else if (this.crtcSel < 16) this.crtc[this.crtcSel] = d; }
    if (z.IORQ === 1 || z.WR === 1) return;            // the other devices are written through IOWR (IORQ and WR)
    if (!(p & 0x2000)) this.romSel = v;                // upper ROM number: with no expansion ROMs every number gives BASIC
    if (!(p & 0x1000)) this.printer = v;
    if (this.ppiF ? this.ppiCS(p) : !(p & 0x0800)) this.ppiWrite(p, v);
  }
  // a byte arriving at the gate array's data pins while its port is addressed
  gaWrite(v) {
    if (this.gf) { const g = this.gv; if ('CK16' in g || g.RESET === 0) return; v = v & this.gDAnd | this.gDOr; }
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
  setGateArray(part) { if (!CPC_GA_PINS[part]) return; this.ga.part = part; this.clearChip('IC116', true); }
  // the 6845's VSYNC pin, through any fault on it (it also goes to the 8255)
  vsOut() { const f = this.vdu.lv.VSYNC; return f === undefined ? this.vsync : !!f; }   // (the 8255's PB0 pin fault is in pbAnd/pbOr)
  char() {
    const R = this.crtc, g = this.gf ? this.gv : null, c = this.vdu.faulty ? this.vdu.lv : null;
    if (c && c.RESET === 0) { this.hcc = 0; this.vcc = 0; this.vlc = 0; this.hs = false; this.vsync = false; this.vde = false; }   // the 6845 held in reset: no sync, no display
    const stopped = (g && 'CCLK' in g) || (c && ('CLK' in c || c.RESET === 0));   // the 6845 has no clock: its counters stand still
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
        const a = (ma & 0x3000) << 2 | (ra & 7) << 11 | (ma & 0x3FF) << 1, slow = this.faulty && (this.ramBank.faulty || this.gf);
        for (let half = 0, p = o; half < 2; half++) {
          const va = this.selF ? this.selVid(a | half) : a | half;
          let v = slow || this.selF ? this.ramRead(va, true) : this.ram[va]; this.ramBus = v; if (g) v = v & this.gDAnd | this.gDOr;
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
    let t = 0; const free = this.rdy === 1;                              // READY held high: no wait states
    for (const c of cyc) {
      if (c.k === 'ID') { c.t0 = this.t + t; t += c.n; continue; }
      const off = c.k === 'IA' ? 3 : c.k === 'IR' || c.k === 'IW' ? 2 : 1, len = c.k === 'IA' ? 6 : c.k === 'M1' || off === 2 ? 4 : 3;
      const w = free ? 0 : (1 - (this.t + t + off)) & 3;
      c.w = w; c.t0 = this.t + t; this.waits += w; t += len + w;
    }
    this.t += t;
    if (this.tapePlay) this.tapeMove(t);
    if (this.rec && this.motorOn()) this.rec.clock += t;
    if (this.audioRate) { this.audioT += t * this.audioRate; while (this.audioT >= CPC.CPU_HZ) { this.audioT -= CPC.CPU_HZ; this.audioSample(); } }
    // the gate array recognises the acknowledge by IORQ and M1 both low
    if (this.cpu.lastEvent === 'INT') { this.ints++; if (!(this.gf && (this.gv.IORQ === 1 || this.gv.M1 === 1))) { this.intCnt &= 31; this.intReq = false; } }
    // keep the last recorded character: the first clocks of this instruction still belong to it
    if (this.vlN) { const n = this.vlN - 1; this.vlT[0] = this.vlT[n]; this.vlF[0] = this.vlF[n]; this.vlM[0] = this.vlM[n]; this.vlN = 1; }
    if (this.gaDead()) { if (!this.dark) { this.fb.fill(20); this.dark = true; } this.rgb = 20; this.gHs = this.gVs = false; this.vt = this.t - (this.t & 3) + 4; }   // no dot clock: no picture
    else { this.dark = false; while (this.vt < this.t) { this.char(); this.vt += 4; } }
    return t;
  }
  // ---- instant loading. The firmware reads each tape record with CAS READ (jump block BCA1h: HL address, DE length,
  // A sync byte). When the Z80 is about to run that routine in the lower ROM, the next record on the tape with that
  // sync byte is decoded from the file (256-byte segments, each with its CRC), written to RAM, the tape is wound past
  // it, and the routine returns as if it had read it: carry set, or carry clear and A = 2 for a CRC error. Programs
  // with their own loaders do not call it, and still load from the signal.
  casReadAddr() { const r = this.ram; return r[0xBCA1] === 0xCF ? (r[0xBCA2] | r[0xBCA3] << 8) & 0x3FFF : -1; }
  preStep() {
    if (!this.instant || !this.tape || this.rec || this.gf || this.busF) return;
    const pc = this.cpu.pc; if (pc >= 0x4000 || (this.gaMode & 4) || pc !== this.casReadAddr()) return;
    this.casTrap();
  }
  casTrap() {
    const c = this.cpu, tp = this.tape, sync = c.a, want = (c.d << 8 | c.e) || 0x10000;
    const k0 = Math.max(0, this.tapeBlock()); let k = -1;
    for (let q = k0; q < tp.blocks.length; q++) { const bl = tp.blocks[q]; if (!bl.data || bl.end <= this.tapeIdx) continue; if (bl.data[0] === sync) { k = q; break; } }
    if (k < 0) return false;                                       // nothing to read: let the firmware wait for the signal
    const bl = tp.blocks[k], d = bl.data.subarray(1);
    let ok = true, a = c.h << 8 | c.l, got = 0;
    for (let s = 0; got < want; s++) {
      const seg = d.subarray(s * 258, s * 258 + 256); if (seg.length < 256 || d.length < s * 258 + 258) { ok = false; break; }
      if (CPCTape.crc(seg) !== (d[s * 258 + 256] << 8 | d[s * 258 + 257])) { ok = false; break; }
      for (let i = 0; i < 256 && got < want; i++, got++) this.ram[(a + i) & 0xFFFF] = seg[i];
      a += 256;
    }
    this.tapeSeek(bl.end); this.casLoads = (this.casLoads || 0) + 1;
    c.f = ok ? c.f | 1 : c.f & ~1; if (!ok) c.a = 2;
    c.pc = this.peek(c.sp) | this.peek((c.sp + 1) & 0xFFFF) << 8; c.sp = (c.sp + 2) & 0xFFFF;   // RET
    return true;
  }
  // ---- cassette ----
  // a CDT (TZX) file, or a WAV recording, which is converted to a CDT first (tape.cdt then holds the file made)
  insertTape(bytes, name) {
    const wav = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const cdt = wav ? CPCTape.fromWav(bytes, name) : bytes;
    this.tape = new CPCTape(cdt); this.tape.cdt = cdt; this.tape.fromWav = wav; this.tapePlay = false; this.tapeSeek(0); return this.tape;
  }
  ejectTape() { this.tape = null; this.tapePlay = false; this.tapeLevel = 0; }
  tapeSeek(seg) { const tp = this.tape; if (!tp) return; this.tapeIdx = Math.min(seg, tp.n); this.tapeRem = tp.dur[this.tapeIdx] || 0; this.tapeLevel = tp.lvl[this.tapeIdx] || 0; this.tapePos = 0; for (let q = 0; q < this.tapeIdx; q++) this.tapePos += tp.dur[q]; }
  motorOn() { return !!(this.ppiCout() & 0x10); }
  tapeIn() { return this.tape && this.tapeIdx < this.tape.n ? this.tapeLevel : 0; }     // port B bit 7
  tapeMove(t) {
    const tp = this.tape; if (!tp || !this.motorOn()) return;
    while (t > 0) {
      if (this.tapeIdx >= tp.n) { this.tapePlay = false; this.tapeLevel = 0; return; }        // the end of the tape
      if (this.tapeRem > t) { this.tapeRem -= t; this.tapePos += t; return; }
      t -= this.tapeRem; this.tapePos += this.tapeRem; this.tapeIdx++;
      if (this.tapeIdx < tp.n) { this.tapeRem = tp.dur[this.tapeIdx]; this.tapeLevel = tp.lvl[this.tapeIdx]; }
      if (tp.stops.has(this.tapeIdx)) { this.tapePlay = false; return; }                    // a "stop the tape" block
    }
  }
  // ---- recording: REC and PLAY down. The cassette output (port C bit 5) is recorded while the motor is on, as the
  // times between its edges; the tape does not move while the motor is off.
  recStart() { this.tapePlay = false; this.rec = { pulses: [], clock: 0, last: 0, level: (this.ppiCout() >> 5) & 1 }; }
  recEdge() {
    const r = this.rec; if (!r || !this.motorOn()) return;
    const l = (this.ppiCout() >> 5) & 1; if (l === r.level) return;
    r.level = l; r.pulses.push(r.clock - r.last); r.last = r.clock;
  }
  recStop() { const r = this.rec; this.rec = null; if (!r) return null; if (r.clock > r.last) r.pulses.push(r.clock - r.last); return CPCTape.fromPulses(r.pulses); }
  tapeBlock() { const tp = this.tape; if (!tp) return -1; let k = -1; for (let q = 0; q < tp.blocks.length && tp.blocks[q].seg <= this.tapeIdx; q++) k = q; return k; }
  // ---- sound ----
  soundClock() { return !(this.gaDead() || (this.gf && 'CCLK' in this.gv) || (this.ayF && ('CLOCK' in this.ay.lv || this.ay.lv.RESET === 0))); }     // does CCLK reach the sound chip?
  envLevel() {      // 0-15 from the envelope shape (register 13: continue, attack, alternate, hold) and position
    const sh = this.psg[13], cyc = this.envPos >> 4, i = this.envPos & 15, up0 = !!(sh & 4), alt = !!(sh & 2);
    if (cyc >= 1) { if (!(sh & 8)) return 0; if (sh & 1) return up0 !== alt ? 15 : 0; }
    const up = alt && (cyc & 1) ? !up0 : up0;
    return up ? i : 15 - i;
  }
  // one sample of each channel's level (0-1), into the left and right buffers
  audioSample() {
    const g = this.psg, mix = g[7], ticks = this.soundClock() ? CPC.PSG_TICK_HZ / this.audioRate : 0;
    const np = ((g[6] & 31) || 1) * 2; this.noiseCnt += ticks;
    while (this.noiseCnt >= np) { this.noiseCnt -= np; const b = (this.lfsr ^ (this.lfsr >> 3)) & 1; this.lfsr = (this.lfsr >> 1) | (b << 16); }
    const ep = ((g[11] | g[12] << 8) || 1) * 2; this.envCnt += ticks;
    while (this.envCnt >= ep) { this.envCnt -= ep; if (++this.envPos >= 64) this.envPos -= 32; }
    const noise = this.lfsr & 1, lv = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const p = (g[ch * 2] | (g[ch * 2 + 1] & 15) << 8) || 1;
      this.toneCnt[ch] += ticks;
      if (this.toneCnt[ch] >= p) { const n = Math.floor(this.toneCnt[ch] / p); this.toneCnt[ch] -= n * p; if (n & 1) this.toneOut[ch] ^= 1; }
      const on = (this.toneOut[ch] | ((mix >> ch) & 1)) & (noise | ((mix >> (ch + 3)) & 1));
      if (on && !(this.ayF && 'ABC'[ch] in this.ay.lv)) { const v = g[8 + ch]; lv[ch] = CPC_PSG_VOL[v & 16 ? this.envLevel() : v & 15]; }   // an output with a fault is silent
    }
    const i = this.aw++ & 32767; this.abufL[i] = (lv[0] + lv[1] / 2) / 1.5; this.abufR[i] = (lv[2] + lv[1] / 2) / 1.5;
  }
  // a tone period as Hz, and the nearest note
  static toneHz(p) { return p ? 62500 / p : 0; }
  static note(p) { if (!p) return ''; const n = Math.round(12 * Math.log2(62500 / p / 440)) + 57; return n < 0 || n > 119 ? '' : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + Math.floor(n / 12); }
  intOut() { const zi = this.z80.lv.INT; if (zi !== undefined) return zi === 0; const f = this.gv.INT; return f === undefined ? this.intReq : f === 0; }   // what the Z80 sees on its INT pin
  syncInt() { this.cpu.intLine = this.intOut(); }
  step() { this.preStep(); this.syncInt(); return this.afterStep(this.cpu.step()); }
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
if (typeof module !== 'undefined') module.exports = { CPCMachine, CPCChip, CPC, CPC_NETS, CPC_GA_PINS, CPC_CRTC_PINS, CPC_Z80_PINS, cpcCrc32 };
