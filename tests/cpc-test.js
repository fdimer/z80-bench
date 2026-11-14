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
{ // bus faults (on the Z80's pins) and the chip pins that override them
  const lo = new Uint8Array(0x4000).fill(0xFF); for (let i = 0; i < 0x4000; i++) lo[i] = i & 0xFF; lo[0] = 0x01;
  const m = new CPCMachine(); m.loadRom(lo, 'lo'); m.gaMode = 0x08;                 // lower ROM on, upper off
  memSetFault(m, 'IC111', 'A3', 0); m.ram[0x4000] = 0x5A; m.ram[0x4008] = 0xA5;
  ok('bus A3 low: every chip sees A3 low', m.read(0x4008) === 0x5A && m.read(0x0018) === 0x10);
  memSetFault(m, 'IC103', 'A3', 1); ok('the ROM\'s own A3 pin overrides the bus fault', m.read(0x0010) === 0x18 && m.read(0x4008) === 0x5A);
  memSetFault(m, 'IC103', 'A3', null); memSetFault(m, 'IC111', 'A3', null); ok('cleared', m.read(0x4008) === 0xA5 && !m.faulty);
  memSetFault(m, 'IC111', 'D0', 0); m.write(0x5000, 0xFF); ok('bus D0 low: written and read with bit 0 low', m.ram[0x5000] === 0xFE && m.read(0x5000) === 0xFE);
  memSetFault(m, 'IC120', 'DIN', 1); m.write(0x5001, 0x00); ok('the RAM chip\'s own data-in pin overrides it; the CPU still reads the stuck line', (m.ram[0x5001] & 1) === 1 && m.read(0x5001) === 0x00);
  memSetFault(m, 'IC120', 'DIN', null); memSetFault(m, 'IC111', 'D0', null);
  memSetFault(m, 'IC111', 'IORQ', 1); ok('bus IORQ high: the gate array sees it', m.gv.IORQ === 1); m.output(0x7F00, 0x8D); ok('no I/O reaches the gate array', m.gaMode === 0x08);
  memSetFault(m, 'IC116', 'IORQ', 0); ok('the gate array\'s own IORQ pin overrides it', m.gv.IORQ === 0); memSetFault(m, 'IC116', 'IORQ', null); memSetFault(m, 'IC111', 'IORQ', null);
  const reg = (r, v) => { m.output(0xBC00, r); m.output(0xBD00, v); };
  reg(2, 41); ok('6845 written', m.crtc[2] === 41);
  memSetFault(m, 'IC108', 'D0', 0); reg(2, 43); ok('6845 D0 pin low: it stores 42', m.crtc[2] === 42); memSetFault(m, 'IC108', 'D0', null);
  memSetFault(m, 'IC108', 'CS', 1); reg(2, 33); ok('6845 CS pin high: not written', m.crtc[2] === 42); memSetFault(m, 'IC108', 'CS', null);
  memSetFault(m, 'IC111', 'A14', 1); reg(2, 34); ok('bus A14 high: the 6845 is never selected', m.crtc[2] === 42);
  memSetFault(m, 'IC108', 'CS', 0); reg(2, 35); ok('the 6845\'s own CS pin overrides it', m.crtc[2] === 35); memSetFault(m, 'IC108', 'CS', null); memSetFault(m, 'IC111', 'A14', null);
  memSetFault(m, 'IC111', 'WR', 1); m.output(0xF600, 0x05); m.write(0x5002, 0x77); ok('bus WR high: the 8255 is not written, the RAM still is (the gate array makes MWE from MREQ and RD)', m.ppiC === 0 && m.ram[0x5002] === 0x77); memSetFault(m, 'IC111', 'WR', null);
  memSetFault(m, 'IC111', 'CLK', 0); const pc = m.cpu.pc; m.run(400); ok('Z80 CLK pin fault: the Z80 alone stops', m.cpu.pc === pc && /CLK/.test(m.held())); memSetFault(m, 'IC111', 'CLK', null);
  ok('all cleared', !m.faulty && !m.gf && !m.busF && m.held() === null);
}
{ // interrupt counter: 52 HSYNCs, and VSYNC resynchronisation
  const m = new CPCMachine(); m.gaMode = 0x0C; [63, 40, 46, 0x8E, 38, 0, 25, 30, 0, 7].forEach((v, r) => { m.output(0xBC00, r); m.output(0xBD00, v); });
  ok('line is 256 clocks', m.lineT() === 256); ok('frame is 312 lines', m.frameLines() === 312);
  m.cpu.pc = 0x100; let first = -1, n = 0, frames0 = m.frames;
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
  { // the picture: blue border, yellow text on blue, 4 characters of border each side, 36 lines above
    const W = CPC.FW, px = (x, y) => m.fb[y * W + x], row = y => new Set(m.fb.subarray(y * W + 64, y * W + 704));
    ok('picture: border is blue', px(8, 8) === 4 && px(760, 264) === 4 && px(63, 100) === 4, [px(8, 8), px(760, 264)].join());
    ok('picture: text lines are yellow on blue', [44, 45, 46].every(y => { const r = row(y); return r.size === 2 && r.has(10) && r.has(4); }), [...row(45)].join());
    ok('picture: blank row above the text', row(37).size === 1 && row(37).has(4));
    ok('picture: first dot of the display is at 64, 36', (() => { const sv = m.ram[0xC000]; m.ram[0xC000] = 0xF0; m.run(4000000 / 25); const r = px(64, 36) === 10 && px(71, 36) === 10 && px(63, 36) === 4 && px(72, 36) === 4; m.ram[0xC000] = sv; return r; })(), px(64, 36));
    { const p0 = m.pictures, f0 = m.frames; m.run(4000000); ok('50 pictures a second, one per 6845 frame', m.pictures - p0 === 50 && m.frames - f0 === 50, (m.pictures - p0) + ' ' + (m.frames - f0)); }
  }
  { const i0 = m.ints; m.run(4000000); ok('interrupts running at 300 a second', Math.abs(m.ints - i0 - 300) <= 1, m.ints - i0); }
  // type a line
  const type = s => { for (const ch of s) { const k = ch === '\n' ? 'Return' : ch === ' ' ? 'Space' : ch === '"' ? '2' : ch === '?' ? '/' : ch === '*' ? ':' : ch.toUpperCase(); const sh = '"?*'.includes(ch); if (sh) m.key('Shift', true); m.run(80000); m.key(k, true); m.run(240000); m.key(k, false); if (sh) m.key('Shift', false); m.run(160000); } };
  type('?3*4\n'); m.run(2000000); const s2 = m.screenText(); console.log(s2.slice(4, 10).map(l => '  |' + l).join('\n'));
  ok('BASIC computes 3*4', s2.some(l => l.trim() === '12'));
  // a RAM fault stops it
  const b = new CPCMachine(); b.rom.set(m.rom); b.hasLo = b.hasHi = true; memSetFault(b, 'IC120', 'DOUT', 0); b.run(4000000 * 3);
  ok('dead data bit 0: no Ready', !b.screenText().includes('Ready'));
  { // gate array faults
    const g = () => { const x = new CPCMachine(); x.rom.set(m.rom); x.hasLo = x.hasHi = true; return x; };
    let x = g(); memSetFault(x, 'IC116', 'INT', 'z'); x.run(4000000 * 3); ok('INT disconnected: starts, but no interrupts taken', x.screenText().includes('Ready') && x.ints === 0, x.ints);
    x = g(); memSetFault(x, 'IC116', 'ROMEN', 1); x.run(4000000); ok('ROMEN high: the ROM never answers', x.cpu.pc !== 0 && !x.screenText().includes('Ready'));
    x = g(); memSetFault(x, 'IC116', 'RAMRD', 'z'); x.run(4000000 * 3); ok('RAMRD disconnected: RAM cannot be read', !x.screenText().includes('Ready') || x.read(0x4000) === 0xFF);
    x = g(); memSetFault(x, 'IC116', 'MWE', 1); x.run(4000000 * 3); ok('MWE high: nothing is written', x.ram.every(v => v === 0));
    x = g(); x.run(4000000 * 3); memSetFault(x, 'IC116', 'DISPEN', 0); x.run(4000000 / 10); ok('DISPEN low: all border', new Set(x.fb.subarray(60 * 768, 200 * 768)).size === 1);
    memSetFault(x, 'IC116', 'DISPEN', null); memSetFault(x, 'IC116', 'VSYNC', 0); const p0 = x.pictures; x.run(4000000); ok('VSYNC missing: the picture rolls (monitor free-runs)', Math.abs((x.pictures - p0) - 50) > 2, x.pictures - p0);
    memSetFault(x, 'IC116', 'VSYNC', null);
    // 6845 faults: MA0 held low shows every other character twice; VSYNC disconnected also reaches the 8255
    x.run(4000000 / 5); const good = x.fb.slice(); memSetFault(x, 'IC108', 'MA0', 0); x.run(4000000 / 5);
    ok('6845 MA0 low: the picture changes, in character pairs', (() => { let diff = 0, pair = true; const W = 768; for (let y = 44; y < 52; y++) for (let ch = 4; ch < 44; ch += 2) for (let i = 0; i < 16; i++) { const a = x.fb[y * W + ch * 16 + i], b = x.fb[y * W + (ch + 1) * 16 + i]; if (a !== b) pair = false; if (a !== good[y * W + ch * 16 + i] || b !== good[y * W + (ch + 1) * 16 + i]) diff++; } return diff > 0 && pair; })());
    memSetFault(x, 'IC108', 'MA0', null); memSetFault(x, 'IC108', 'VSYNC', 'z'); x.run(4000); ok('6845 VSYNC disconnected: port B bit 0 reads high', (x.input(0xF500) & 1) === 1);
    memSetFault(x, 'IC108', 'VSYNC', null);
    // clocks and READY: the processor is held while the video goes on
    for (const [pin, lvl, why] of [['PHI', 'z', /PHI/], ['READY', 0, /READY/]]) {
      memSetFault(x, 'IC116', pin, lvl); const pc = x.cpu.pc, p1 = x.pictures, t1 = x.t; x.run(4000000);
      ok(pin + ' fault: Z80 held, picture still drawn', x.cpu.pc === pc && Math.abs(x.pictures - p1 - 50) <= 1 && x.t - t1 >= 4000000 && why.test(x.held()), x.pictures - p1);
      memSetFault(x, 'IC116', pin, null);
    }
    { const pc = x.cpu.pc; x.run(4000); ok('released: the Z80 runs again', x.cpu.pc !== pc && x.held() === null); }
    memSetFault(x, 'IC116', 'CK16', 0); { const pc = x.cpu.pc; x.run(400000); ok('no 16 MHz: everything stops, no picture', x.cpu.pc === pc && x.fb.every(v => v === 20)); } memSetFault(x, 'IC116', 'CK16', null);
    x.run(4000000 / 2);
    for (const [id, pin] of [['IC116', 'CCLK'], ['IC108', 'CLK']]) {
      memSetFault(x, id, pin, 0); x.run(40000); const f1 = x.frames, i1 = x.ints, t1 = x.t, pc = x.cpu.pc; x.run(4000000 / 2);
      ok(id + ' ' + pin + ' fault: the 6845 stands still, no interrupts, Z80 runs', x.frames === f1 && x.ints - i1 <= 1 && x.t - t1 >= 2000000 && x.held() === null, (x.frames - f1) + ' ' + (x.ints - i1));
      memSetFault(x, id, pin, null); x.run(4000000 / 2);
    }
    // READY high from power-on: no wait states, and the machine does not start (RAM accesses out of step)
    x = g(); memSetFault(x, 'IC116', 'READY', 1); x.run(4000000 * 2); ok('READY high: no wait states, no Ready', x.waits === 0 && !x.screenText().includes('Ready'));
    // the gate array's address and control inputs
    x = g(); memSetFault(x, 'IC116', 'A15', 1); x.run(4000000 * 2); ok('A15 to the gate array high: the lower ROM is never switched in', !x.screenText().includes('Ready') && x.read(0x0000) === x.ram[0]);
    x = g(); memSetFault(x, 'IC116', 'IORQ', 'z'); x.run(4000000 * 2); ok('IORQ to the gate array missing: its registers are never written', x.gaMode === 0 && x.pens.every(v => v === 0) && x.acc[2] === 0, x.gaMode);
    x = g(); memSetFault(x, 'IC116', 'D0', 0); x.run(4000000 * 3); ok('D0 to the gate array low: screen mode 0 instead of 1', (x.gaMode & 3) === 0 && x.vmode === 0, x.gaMode);
    // the recorded video signals: one entry per character, four clocks apart, and the last one is "now"
    x = g(); x.run(4000000 * 2); x.step(); x.step();
    ok('video record: characters four clocks apart', x.vlN >= 2 && [...Array(x.vlN - 1).keys()].every(k => x.vlT[k + 1] - x.vlT[k] === 4), x.vlN);
    ok('video record: the last clock matches the present state', (() => { const v = x.videoAt(x.t - 1), n = x.videoAt(); return v.vs === n.vs && v.rgb === x.rgb; })());
    ok('video record: HSYNC seen rising at the right character', (() => { for (let i = 0; i < 400; i++) { x.step(); for (let k = 1; k < x.vlN; k++) if ((x.vlF[k] & 1) && !(x.vlF[k - 1] & 1)) { const a = x.videoAt(x.vlT[k] - 1), b = x.videoAt(x.vlT[k]); return a.hs === 0 && b.hs === 1; } } return false; })());
    x.setGateArray('40007'); ok('40007 pinout selected', x.ga.part === '40007' && !x.faulty);
  }
} else console.log('(set CPC_ROMS to run the boot checks)');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
