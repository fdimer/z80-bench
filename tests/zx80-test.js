// ZX80 video-logic checks with a synthetic ROM (no Sinclair code): node tests/zx80-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'z80asm.js', 'memchips.js', 'zx80.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.ZX80 = ZX80; this.ZX = ZX; this.assemble = assemble;', ctx);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
// A tiny display driver in the ZX80 style: 4 characters then HALT, 8 scan lines per frame.
const src = `
        ORG  0
        ld   sp,4400h
        ld   a,0Eh
        ld   i,a            ; font page 0E00h, as in the ZX80 ROM
        im   1
frame:  in   a,(0FEh)       ; vertical sync on (read with A0 low)
        ld   b,0
vs:     djnz vs
        out  (0FFh),a       ; vertical sync off, line counter cleared
        ld   c,8
        ld   hl,0C000h      ; display file 4000h seen through the A15 mirror
        ld   a,70h
        ei
        ld   r,a
        jp   (hl)           ; chars fetched with R = 71h-74h, HALT at 75h, /INT when R reaches 00h
        ORG  38h
        pop  de
        dec  c
        jr   z,frame
        ld   hl,0C000h
        ld   a,70h
        ei
        ld   r,a
        jp   (hl)
        ORG  0E08h          ; character 1: a diagonal, row r = 80h >> r
        db   80h,40h,20h,10h,08h,04h,02h,01h
        db   0FFh,81h,81h,81h,81h,81h,81h,0FFh   ; character 2: a box
`;
const r = ctx.assemble(src); ok(!r.errors.length, 'synthetic ROM assembles ' + (r.errors[0] ? r.errors[0].msg : ''));
const rom = new Uint8Array(0x1000); for (const c of r.chunks) c.bytes.forEach((v, i) => { rom[c.addr + i] = v; });
const m = new ctx.ZX80(rom);
// display file: char 1, char 2, inverse char 1 (bit 7), char 2, HALT
[0x01, 0x02, 0x81, 0x02, 0x76].forEach((v, i) => { m.ram[i] = v; });
m.run(200000);
ok(m.frames >= 3, `vertical sync recognised (${m.frames} frames)`);
// find the drawn lines in the last full picture
const W = ctx.ZX.W, rows = [];
for (let y = 0; y < ctx.ZX.H; y++) { let s = ''; for (let x = 0; x < W; x++) s += m.front[y * W + x] ? '#' : '.'; if (s.includes('#')) rows.push([y, s]); }
ok(rows.length === 8, `8 scan lines drawn (got ${rows.length})`);
// line 0 follows vertical sync rather than a horizontal sync, so measure the others against line 1
const first = rows.length > 1 ? Math.min(...rows.slice(1).map(([, s]) => s.indexOf('#') - rows.slice(1).findIndex(q => q[1] === s))) : -1;
const starts = rows.map(([, s]) => s.search(/[#]/));
console.log('     first ink x per line:', starts.join(' '));
const x1 = rows.length > 1 ? starts[1] - 1 : 0;   // line 1 starts with char 1 row 1 = .#......
const cells = rows.map(([, s], i) => i === 0 ? s.slice(starts[0], starts[0] + 32) : s.slice(x1, x1 + 32));
console.log(cells.map((c, i) => '     ' + i + ' ' + c).join('\n'));
const expect = r => { const d = (0x80 >> r), box = r === 0 || r === 7 ? 0xFF : 0x81; const b = v => v.toString(2).padStart(8, '0').replace(/1/g, '#').replace(/0/g, '.'); return b(d) + b(box) + b(d ^ 0xFF) + b(box); };
ok(cells.every((c, i) => c === expect(i)), 'each line shows the font row picked by the line counter, inverse video on bit 7');
ok(rows.every(([y], i) => i === 0 || y === rows[i - 1][0] + 1), 'lines are consecutive (one per interrupt acknowledge)');
// the data bus during a character fetch carries the forced NOP
m.cpu.log = true;
let seen = null; for (let i = 0; i < 5000 && !seen; i++) { const c0 = m.cpu.pc; m.syncInt(); const cyc = m.cpu.step(); m.afterStep(cyc); for (const c of cyc) if (c.k === 'M1' && c.a >= 0xC000 && c.a < 0xC004) seen = c; }
ok(seen && seen.d === 0x00, 'character fetches put a NOP on the CPU data bus');
// keyboard: half-row A11 (1-5), key 3 is D2
m.key('3', true); ok((m.input(0xF7FE) & 0x1F) === 0x1B, 'key 3 reads on D2 of half-row A11');
ok((m.input(0xFEFE) & 0x1F) === 0x1F, 'other half-rows unaffected'); m.key('3', false);
// the Timex Sinclair 1000's built-in RAM: one 2K chip (IC4) that repeats every 2K
{ const t = new ctx.ZX80(rom); t.ramSize = 0x800; t.reset();
  t.write(0x4000, 0x11); t.write(0x4400, 0x22); t.write(0x47FF, 0x33);
  ok(t.read(0x4000) === 0x11 && t.read(0x4400) === 0x22, '2K RAM: 4000h and 4400h are different cells (they are the same cell with 1K)');
  ok(t.read(0x4800) === 0x11 && t.read(0x4FFF) === 0x33, '2K RAM repeats every 2K');
  ok(t.ramBank(0)[0].id === 'IC4-2K', '2K RAM is the single chip in IC4');
  vm.runInContext('this.memBankFlag = memBankFlag;', ctx);
  t.write(0x4123, 0xFF); t.chipById['IC4-2K'].setFault('D3', 0); t.faulty = ctx.memBankFlag(t.ram2k);
  ok(t.read(0x4123) === 0xF7, '2K RAM: data pin D3 stuck low clears bit 3 on a read');
  t.chipById['IC4-2K'].setFault('D3', null); t.chipById['IC4-2K'].setFault('A10', 0); t.faulty = ctx.memBankFlag(t.ram2k);
  ok(t.read(0x4400) === 0x11, '2K RAM: address pin A10 stuck low makes the upper 1K read the lower 1K'); }
// the ZX81's ULA and the Z80 as chips: lines, and the two kinds of fault (a line held, a pin disconnected)
{ const z = new ctx.ZX80(rom, 'zx81'); z.reset();
  const N = z.nets();
  ok(N["A3'"].pins.length === 4 && N.D0.pins.length === 2 && N["D5'"].pins.join() === 'IC2-8K,D5,IC4,I/O2', "ZX81 lines: A3' joins the ULA, the ROM and both 2114s; D0 the Z80 and the ULA; D5' the ROM and the second 2114");
  ok(N.A6.pins.join() === 'CPU,A6,CPU,INT' && N.WR.pins.length === 4 && N.RAMCS.pins.length === 3, 'ZX81 lines: INT is on A6; WR reaches both 2114s; RAMCS the ULA and both 2114s');
  z.ramSize = 0x800; z.applyFaults(); ok(z.nets().RAMCS.pins.join() === 'ULA,RAMCS,IC4-2K,CE,IC4-2K,OE' && z.nets().A10.pins.length === 3, '2K RAM: CE and OE are both on RAMCS, and A10 reaches the chip');
  z.ramSize = 0x400; z.applyFaults();
  { const N0 = new ctx.ZX80(rom).nets(); ok(N0['A3~'].pins.join() === 'IC8,Ya,IC2,A3,IC3,A3,IC4,A3' && N0.V3.pins.join() === 'IC5,Q0,IC8,I0a' && N0['D7~'].pins.join() === 'IC2,D7,IC3,I/O1,IC5,D7,IC9,D7,IC10,Y1', 'ZX80 lines: A3~ from IC8 to the ROM and RAMs; the latch\'s Q0 to IC8; D7~ to IC3 I/O1, the latch, the shift register and the tape input'); }
  z.write(0x4010, 0xFF); const r0 = z.read(0x0E08);
  z.setNetFault("D7'", 0); ok(z.read(0x4010) === 0x7F && z.read(0x0E08) === (r0 & 0x7F), "line D7' held low: bit 7 reads low from the RAM and from the ROM");
  ok(z.chipById.IC4.f['I/O4'] === 0 && z.chipById['IC2-8K'].f.D7 === 0 && !('D7' in z.z80c.f), "the held line shows on the pins on it, and not on the Z80's D7");
  z.setNetFault("D7'", null); z.setPinFault('IC4', 'I/O1', 0); ok(z.read(0x4010) === 0xEF && z.read(0x0E08) === r0, 'a 2114 data pin disconnected at low: only that chip is affected');
  z.clearFaults(); ok(z.read(0x4010) === 0xFF && !z.fx && !z.faulty, 'clearing the faults restores the machine');
  z.setPinFault('ULA', 'A14', 0); ok(z.read(0x4010) === z.rom[0x0010] && z.peek(0x0E08) === r0, 'ULA A14 pin at low: it selects the ROM for a RAM address');
  z.setPinFault('ULA', 'A14', 1); z.write(0x4020, 0x5A); ok(z.read(0x0020) === 0x5A, 'ULA A14 pin at high: it selects the RAM for a ROM address');
  z.clearFaults(); z.setPinFault('ULA', 'MREQ', 'z'); ok(z.read(0x0E08) === 0xFF && z.read(0x4010) === 0xFF, 'ULA MREQ pin disconnected: neither memory is selected, the bus reads FFh');
  z.clearFaults(); z.setPinFault('CPU', 'MREQ', 'z'); ok(z.ulaC.f.MREQ === 'z' && z.read(0x4010) === 0xFF, "the Z80's MREQ pin disconnected: the line floats, and the ULA's MREQ pin shows it");
  z.clearFaults(); z.setNetFault('WR', 1); z.write(0x4010, 0x00); z.clearFaults(); ok(z.read(0x4010) === 0xFF, 'WR line held high: writes are lost');
  z.setNetFault('A3', 1); ok(z.read(0x4010) === z.read(0x4018) && z.busA(0) === 8, 'A3 held high at the Z80: every address has bit 3 set'); z.clearFaults();
  z.setPinFault('CPU', 'A6', 'z'); ok(z.z80c.f.INT === 'z', "the Z80's A6 pin disconnected: its INT pin, on the same line, floats"); z.intLevel = true; z.syncInt(); ok(!z.cpu.intLine, 'and no interrupt reaches it'); z.clearFaults();
  z.setNetFault('CLK', 0); ok(/clock/.test(z.held()) && z.step() === 4 && z.cpu.pc === 0, 'clock line held: the Z80 is held, four clocks pass'); z.clearFaults(); ok(z.held() === null, 'and released');
  z.setPinFault('ULA', 'OSC', 0); ok(/oscillator/.test(z.held()) && z.tvDead, 'ULA oscillator pin stuck: no clock and no picture'); z.clearFaults();
  // a character fetch: the ULA feeds the Z80 a NOP through its data pins
  z.ram[0] = 0x01; ok(z.fetch(0xC000) === 0x00 && z.latch === 0x01, 'character fetch: NOP to the Z80, character latched');
  z.setPinFault('ULA', 'D0', 'z'); z.latch = 0; ok(z.fetch(0xC000) === 0x01, 'ULA D0 disconnected: it cannot pull D0 low, the Z80 gets 01h instead of a NOP'); z.clearFaults();
  z.setPinFault('ULA', 'M1', 'z'); ok(z.fetch(0xC000) === 0x01, 'ULA M1 disconnected: it never sees an opcode fetch, the Z80 runs the display file'); z.clearFaults();
  z.setPinFault('ULA', 'A15', 0); ok(z.fetch(0xC000) === 0x01, 'ULA A15 at low: the same'); z.clearFaults();
  z.setNetFault('D6', 1); ok(z.fetch(0xC000) === 0x41, 'D6 held high: the ULA takes every byte for an instruction'); z.clearFaults();
  // ports
  z.key('3', true);
  ok((z.input(0xF7FE) & 0x1F) === 0x1B, 'no fault: key 3 reads');
  z.setPinFault('ULA', 'KBD2', 'z'); ok((z.input(0xF7FE) & 0x1F) === 0x1F, 'ULA KBD2 disconnected: the key is not seen'); z.clearFaults();
  z.setPinFault('ULA', 'KBD0', 0); ok((z.input(0xF7FE) & 0x1F) === 0x1A, 'ULA KBD0 at low: that column reads as pressed'); z.clearFaults();
  z.setPinFault('ULA', 'RD', 'z'); ok(z.input(0xF7FE) === 0xFF, 'ULA RD disconnected: the port does not answer'); z.clearFaults();
  z.setPinFault('ULA', "A0'", 'z'); ok(z.input(0xF7FE) === 0xFF, "ULA A0' disconnected: it never sees A0 low"); z.clearFaults();
  z.setPinFault('ULA', 'D2', 'z'); ok((z.input(0xF7FE) & 0x1F) === 0x1F, 'ULA D2 disconnected: the bit floats high'); z.clearFaults();
  z.setPinFault('ULA', 'USA/UK', 0); ok(!(z.input(0xFEFE) & 0x40), 'USA/UK pin low: the port reports a 60 Hz machine'); z.clearFaults(); z.key('3', false);
  z.output(0xFE); ok(z.nmiGen, 'OUT FEh starts the NMI generator'); z.output(0xFD); z.setPinFault('ULA', 'WR', 'z'); z.output(0xFE); ok(!z.nmiGen, 'ULA WR disconnected: port writes are not seen'); z.clearFaults();
  z.setPinFault('CPU', 'NMI', 'z'); z.output(0xFE); z.cpu.nmiPending = false; z.t += 1000; z.hsyncs(); ok(!z.cpu.nmiPending, "the Z80's NMI pin disconnected: no NMI arrives"); z.clearFaults();
  z.setNetFault('NMI', 1); z.setPinFault('ULA', 'NMI', 'z'); ok(z.faultList().length === 2 && z.chipFaults('CPU').join() === 'NMI: line held high', 'faults are listed as lines and as pins');
  z.clearChip('ULA'); ok(z.faultList().length === 0, "clearing a chip's faults releases its pins and the lines they are on"); }
// ---- the ZX80's video and decoding chips ----
{ const pic = setup => { const t = new ctx.ZX80(rom); [0x01, 0x02, 0x81, 0x02, 0x76].forEach((v, i) => { t.ram[i] = v; }); if (setup) setup(t); t.run(200000);
    const rs = []; for (let y = 0; y < ctx.ZX.H; y++) { let s = ''; for (let x = 0; x < W; x++) s += t.front[y * W + x] ? '#' : '.'; rs.push(s); }
    const y0 = rows.length ? rows[1][0] : 0; return [1, 2, 3, 4, 5, 6, 7].map(i => rs[y0 + i - 1].slice(x1, x1 + 32)); };
  const want = f => [1, 2, 3, 4, 5, 6, 7].map(f), b = v => v.toString(2).padStart(8, '0').replace(/1/g, '#').replace(/0/g, '.'), line = (d, x) => b(d) + b(x) + b(d ^ 0xFF) + b(x);
  const same = (got, exp) => got.every((g, i) => g === exp[i]);
  ok(same(pic(), want(r => line(0x80 >> r, r === 7 ? 0xFF : 0x81))), 'TTL: no faults, the picture as before');
  ok(same(pic(t => t.setPinFault('IC9', 'D7', 0)), want(r => line((0x80 >> r) & 0x7F, (r === 7 ? 0xFF : 0x81) & 0x7F))), 'IC9 D7 stuck low: every character loses its first dot');
  ok(same(pic(t => t.setPinFault('IC9', 'QH', 1)), want(() => line(0xFF, 0xFF))), 'IC9 QH stuck high: character cells solid (inverse ones blank)');
  ok(same(pic(t => t.setPinFault('IC21', 'CP1', 'z')), want(() => line(0x80, 0xFF))), 'IC21 CP1 disconnected: the line counter stops, so every line shows row 0');
  ok(same(pic(t => t.setPinFault('IC21', 'Q1', 1)), want(r => { const k = r | 1; return line(0x80 >> k, k === 7 ? 0xFF : 0x81); })), 'IC21 Q1 stuck high: rows 1, 1, 3, 3, 5, 5, 7');
  ok(same(pic(t => t.setPinFault('IC5', 'Q0', 1)), want(r => line(0x80 >> r, 0))), 'IC5 Q0 stuck high: character 2 becomes character 3 (blank in this ROM)');
  ok(same(pic(t => t.setPinFault('IC5', 'LE', 0)), want(() => '.'.repeat(32))), 'IC5 LE stuck low: the latch keeps character 0, so the line is blank');
  ok(!same(pic(t => t.setPinFault('IC8', 'S', 1)), want(r => line(0x80 >> r, r === 7 ? 0xFF : 0x81))), 'IC8 S stuck high: the ROM sees the refresh address, not the row of the character');
  { const t = new ctx.ZX80(rom); t.setPinFault('IC7', 'E', 1); ok(t.ttlAddr(0x00F3, false) === 0x0003, 'IC7 E high: A4~-A7~ held low'); t.clearFaults();
    t.setNetFault('A5~', 1); ok(t.ttlAddr(0x0000, false) === 0x0020 && t.chipById.IC2.f.A5 === 1, 'line A5~ held high: the ROM and RAMs see A5 high'); t.clearFaults();
    t.key('3', true); t.setPinFault('IC10', 'OE1', 'z'); ok(t.input(0xF7FE) === 0xFF, 'IC10 OE1 disconnected: no keys and no tape'); t.clearFaults();
    t.setPinFault('IC10', 'Y3', 0); ok((t.input(0xFEFE) & 0x1F) === 0x1D, 'IC10 Y3 stuck low: D1 reads as a key down'); t.clearFaults();
    t.ram.fill(0xFF, 0, 0x400); t.setNetFault('KBD', 0); ok(t.read(0xF710) === 0xFB && t.read(0xFF10) === 0xFF, 'KBD held low: the keyboard drives the data lines on every read, so key 3 clears D2 when A11 is low'); t.clearFaults(); t.key('3', false);
    t.write(0x4010, 0xFF); t.setPinFault('IC3', 'I/O1', 0); ok(t.read(0x4010) === 0x7F, 'ZX80 IC3 I/O1 holds D7, as drawn'); t.clearFaults();
    ok(!t.tx && t.faultList().length === 0, 'all cleared'); } }
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
