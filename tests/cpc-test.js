// Amstrad CPC model checks. The timing and memory checks need no ROM; the boot check needs your own ROM images:
//   CPC_ROMS=/folder/with/OS_464.ROM/and/BASIC_1.0.ROM node tests/cpc-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'memchips.js', 'cpc.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8') + '\nthis.Z80 = Z80; this.CPCMachine = typeof CPCMachine !== "undefined" ? CPCMachine : undefined; this.CPC = typeof CPC !== "undefined" ? CPC : undefined; this.memSetFault = typeof memSetFault !== "undefined" ? memSetFault : undefined;', ctx);
const { CPCMachine, CPC, memSetFault } = ctx;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL', name, extra === undefined ? '' : extra); } };
// instruction lengths in clocks on a CPC (always a multiple of four)
const timing = (bytes, setup) => { const m = new CPCMachine(); m.gaMode = 0x0C; m.ram.set(bytes, 0x100); m.cpu.pc = 0x100; m.cpu.sp = 0x8000; if (setup) setup(m); return m.step() + m.step() - 4; };   // with the NOP that follows: the stretch that realigns the next fetch belongs to this instruction
for (const [name, bytes, want, setup] of [
  ['NOP', [0x00], 4], ['LD A,n', [0x3E, 1], 8], ['LD HL,nn', [0x21, 0, 0], 12], ['INC HL', [0x23], 8], ['LD (HL),n', [0x36, 1], 12],
  ['PUSH BC', [0xC5], 16], ['POP BC', [0xC1], 12], ['CALL nn', [0xCD, 0, 2], 20], ['RET', [0xC9], 12], ['JP nn', [0xC3, 0, 2], 12],
  ['JR e', [0x18, 2], 12], ['OUT (n),A', [0xD3, 0], 12], ['OUT (C),A', [0xED, 0x79], 16], ['IN A,(n)', [0xDB, 0], 12], ['LD A,(nn)', [0x3A, 0, 2], 16],
  ['ADD HL,BC', [0x09], 12], ['LDIR (last)', [0xED, 0xB0], 20, m => { m.cpu.b = 0; m.cpu.c = 1; }], ['EX (SP),HL', [0xE3], 24], ['LD (IX+d),n', [0xDD, 0x36, 0, 1], 24], ['RST 38h', [0xFF], 16]
]) { const t = timing(bytes, setup); ok('timing ' + name, t === want, `${t} clocks, expected ${want}`); }
{ // interrupt acknowledge: 20 clocks in mode 1, 28 in mode 2
  for (const [im, want] of [[1, 20], [2, 28]]) { const m = new CPCMachine(); m.gaMode = 0x0C; m.cpu.pc = 0x100; m.cpu.sp = 0x8000; m.cpu.im = im; m.cpu.iff1 = m.cpu.iff2 = 1; m.intReq = true; const t = m.step(), line = m.intReq; ok('interrupt IM ' + im, t + m.step() - 4 === want && line === false, t); }
}
{ // ROM over RAM
  const m = new CPCMachine(), lo = new Uint8Array(0x4000).fill(0x11), hi = new Uint8Array(0x4000).fill(0x22); hi[0] = 0x80; lo[0] = 0x01;
  ok('lower image recognised', m.loadRom(lo) === 'lo'); ok('upper image recognised', m.loadRom(hi) === 'hi');
  ok('lower ROM read', m.read(0x0001) === 0x11 && m.read(0x3FFF) === 0x11); ok('upper ROM read', m.read(0xC001) === 0x22 && m.read(0xFFFF) === 0x22);
  ok('RAM between', (m.write(0x4000, 0x55), m.read(0x4000) === 0x55));
  m.write(0x0001, 0x77); m.write(0xC001, 0x88); ok('writes go under the ROM', m.read(0x0001) === 0x11 && m.ram[0x0001] === 0x77 && m.ram[0xC001] === 0x88);
  m.output(0x7F00, 0x84); ok('lower ROM off', m.read(0x0001) === 0x77 && m.read(0xC001) === 0x22);
  m.output(0x7F00, 0x88); ok('upper ROM off', m.read(0x0001) === 0x11 && m.read(0xC001) === 0x88);
  m.output(0x7F00, 0x8C); ok('both off', m.read(0x0001) === 0x77 && m.read(0xC001) === 0x88);
  m.reset(); ok('reset switches both on', m.read(0x0001) === 0x11 && m.read(0xC001) === 0x22);
}
{ // RAM chips: data bit and address pin faults follow the selectors' wiring
  const m = new CPCMachine(); m.gaMode = 0x0C;
  memSetFault(m, 'IC120', 'DOUT', 0); ok('IC120 is data bit 0', (m.write(0x1234, 0xFF), m.read(0x1234) === 0xFE)); memSetFault(m, 'IC120', 'DOUT', null);
  memSetFault(m, 'IC124', 'DOUT', 0); ok('IC124 is data bit 7', m.read(0x1234) === 0x7F); memSetFault(m, 'IC124', 'DOUT', null);
  ok('fault cleared', m.read(0x1234) === 0xFF && !m.faulty);
  // pin A1 carries CPU A1 (row) and A0 (column): held low, addresses differing only in A0 or A1 share a cell in that chip
  memSetFault(m, 'IC117', 'A1', 0); m.write(0x2000, 0x00); m.write(0x2003, 0x08);
  ok('pin A1 low folds A0 and A1 (bit 3 only)', m.read(0x2000) === 0x08 && m.read(0x2001) === 0x08 && m.read(0x2002) === 0x08); memSetFault(m, 'IC117', 'A1', null);
  // pin A6 carries A8 (row) and A15 (column)
  memSetFault(m, 'IC118', 'A6', 1); m.write(0x8100, 0x04); m.write(0x0000, 0x00);
  ok('pin A6 high folds A8 and A15 (bit 2 only)', m.read(0x0000) === 0x00 && m.read(0x8100) === 0x00 && m.ram[0x8100] === 0x00 || m.read(0x0000) === 0x04, m.read(0x0000));
  memSetFault(m, 'IC118', 'A6', null);
  memSetFault(m, 'IC103', 'O0', 0); const lo = new Uint8Array(0x4000).fill(0xFF); m.loadRom(lo, 'lo'); m.gaMode = 0; ok('ROM data pin fault', m.read(0x0010) === 0xFE);
}
{ // interrupt counter: 52 HSYNCs, and VSYNC resynchronisation
  const m = new CPCMachine(); m.gaMode = 0x0C; [63, 40, 46, 0x8E, 38, 0, 25, 30, 0, 7].forEach((v, r) => { m.output(0xBC00, r); m.output(0xBD00, v); });
  ok('line is 256 clocks', m.lineT() === 256); ok('frame is 312 lines', m.frameLines() === 312);
  m.cpu.pc = 0x100; m.t = 0; m.nextHs = 256; let first = -1, n = 0, frames0 = m.frames;
  for (let i = 0; i < 400000 && m.frames < frames0 + 3; i++) { m.step(); if (m.intReq) { n++; m.intReq = false; if (first < 0) first = m.line; } }
  ok('six interrupts a frame', Math.abs(n - 18) <= 1, n);
  ok('VSYNC seen on port B', (() => { let seen = 0, not = 0; for (let i = 0; i < 20000; i++) { m.step(); if (m.input(0xF500) & 1) seen++; else not++; } return seen > 0 && not > seen; })());
}
// boot with the real ROMs
const dir = process.env.CPC_ROMS;
if (dir) {
  const m = new CPCMachine(); m.loadRom(new Uint8Array(fs.readFileSync(path.join(dir, 'OS_464.ROM')))); m.loadRom(new Uint8Array(fs.readFileSync(path.join(dir, 'BASIC_1.0.ROM'))));
  ok('firmware CRC', m.romCrc(false) === CPC.ROM_LO); ok('BASIC CRC', m.romCrc(true) === CPC.ROM_HI);
  m.run(4000000 * 3);
  const scr = m.screenText(); console.log(scr.slice(0, 10).map(l => '  |' + l).join('\n'));
  ok('sign-on', /Amstrad 64K Microcomputer/.test(scr.join('\n'))); ok('BASIC 1.0', /BASIC 1\.0/.test(scr.join('\n'))); ok('Ready', scr.includes('Ready'));
  { const row = new Uint8Array(640); m.drawLine(8, row); const ink = new Set(row); ok('picture: yellow on blue', ink.size === 2 && ink.has(10) && ink.has(4), [...ink].join()); }
  ok('interrupts running at 300 a second', Math.abs(m.ints / 3 - 300) < 20, m.ints);
  // type a line
  const type = s => { for (const ch of s) { const k = ch === '\n' ? 'Return' : ch === ' ' ? 'Space' : ch === '"' ? '2' : ch === '?' ? '/' : ch === '*' ? ':' : ch.toUpperCase(); const sh = '"?*'.includes(ch); if (sh) m.key('Shift', true); m.run(80000); m.key(k, true); m.run(240000); m.key(k, false); if (sh) m.key('Shift', false); m.run(160000); } };
  type('?3*4\n'); m.run(2000000); const s2 = m.screenText(); console.log(s2.slice(4, 10).map(l => '  |' + l).join('\n'));
  ok('BASIC computes 3*4', s2.some(l => l.trim() === '12'));
  // a RAM fault stops it
  const b = new CPCMachine(); b.rom.set(m.rom); b.hasLo = b.hasHi = true; memSetFault(b, 'IC120', 'DOUT', 0); b.run(4000000 * 3);
  ok('dead data bit 0: no Ready', !b.screenText().includes('Ready'));
} else console.log('(set CPC_ROMS to run the boot checks)');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
