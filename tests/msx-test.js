// MSX model checks with a synthetic program (no Microsoft or Sony code): node tests/msx-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'z80asm.js', 'memchips.js', 'msx.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.MSXMachine = MSXMachine; this.MSXCart = MSXCart; this.MSX = MSX; this.assemble = assemble;', ctx);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
// A tiny "BIOS": text mode, one character pattern, a letter on screen, frame interrupts counted in RAM.
const src = `
        ORG  0
        jp   start
        ORG  100h
start:  di
        ld   sp,0F000h
        im   1
        ld   a,0F0h         ; register 1: display on, interrupt on, text mode
        out  (99h),a
        ld   a,81h
        out  (99h),a
        ld   a,0F4h         ; register 7: white on dark blue
        out  (99h),a
        ld   a,87h
        out  (99h),a
        ld   a,01h          ; register 4: patterns at 0800h
        out  (99h),a
        ld   a,84h
        out  (99h),a
        ld   a,08h          ; video RAM address 0808h (pattern of character 1), write
        out  (99h),a
        ld   a,48h
        out  (99h),a
        ld   a,0FCh
        ld   b,8
pat:    out  (98h),a
        djnz pat
        xor  a              ; address 0000h: name table
        out  (99h),a
        ld   a,40h
        out  (99h),a
        ld   a,1
        out  (98h),a
        ld   a,7            ; keyboard row 7
        out  (0AAh),a
        ei
loop:   in   a,(0A9h)
        ld   (0E001h),a
        jr   loop
        ORG  38h
        push af
        in   a,(99h)        ; acknowledge the frame interrupt
        ld   a,(0E000h)
        inc  a
        ld   (0E000h),a
        pop  af
        ei
        ret
`;
const r = ctx.assemble(src); ok(!r.errors || !r.errors.length, 'test program assembles');
const m = new ctx.MSXMachine();
for (const c of r.chunks) m.bios.set(c.bytes, c.addr); m.hasBios = true; m.reset();
m.run(ctx.MSX.LINE_T * ctx.MSX.LINES * 10 + 5000);
ok(m.mode() === 'text', 'text mode selected through the control port');
ok(m.vram[0x808] === 0xFC && m.vram[0] === 1, 'video RAM written through the data port');
ok(m.ram[0xE000] === 10, 'ten frame interrupts in ten frames (got ' + m.ram[0xE000] + ')');
const B = ctx.MSX.BORDER, px = (x, y) => m.front[(y + B) * ctx.MSX.FW + B + x];
ok(px(8, 0) === 15 && px(13, 7) === 15 && px(14, 0) === 4 && px(0, 0) === 4, 'character drawn 6 pixels wide in the text colours');
ok(m.ram[0xE001] === 0xFF, 'no key: keyboard row reads FFh');
m.key('Return', true); m.run(2000); ok(m.ram[0xE001] === 0x7F, 'RETURN is row 7 bit 7, active low');
m.output(0xA8, 0x50); ok(m.slotOf(2) === 1 && m.slotOf(3) === 1 && m.read(0xE000) === 0xFF, 'slot register switches pages; an empty slot reads FFh');
m.output(0xA8, 0);
const rom = new Uint8Array(0x20000); for (let s = 0; s < 16; s++) rom[s * 0x2000] = s;
const k = new ctx.MSXCart(rom, 'ascii8'); m.carts[1] = k; m.output(0xA8, 0x04); m.write(0x6800, 5);
ok(m.read(0x6000) === 5 && m.read(0x4000) === 0, 'ASCII 8K mapper switches an 8K segment');
m.setMachine('hb75p'); m.output(0xA8, 0xAA); m.write(0x1234, 0x5A); ok(m.read(0x1234) === 0x5A, 'HB-75P: 64K of RAM in slot 2');
// cassette traps: a stand-in BIOS whose tape entry points are never reached, because the model answers them
m.setMachine('hb55p'); m.output(0xA8, 0); m.carts[1] = null;
m.insertTape(new Uint8Array([0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74, 0x55, 0x66]));
m.cpu.sp = 0xF000; m.ram[0xF000] = 0x34; m.ram[0xF001] = 0x12; m.cpu.pc = 0xE1; m.preStep();
ok(m.cpu.pc === 0x1234 && !(m.cpu.f & 1) && m.tapePos === 8, 'TAPION finds the block marker and returns');
m.cpu.sp = 0xF000; m.cpu.pc = 0xE4; m.preStep(); ok(m.cpu.a === 0x55, 'TAPIN reads a byte from the tape');
m.cpu.sp = 0xF000; m.cpu.pc = 0xEA; m.preStep(); m.cpu.a = 0x77; m.cpu.sp = 0xF000; m.cpu.pc = 0xED; m.preStep();
ok(m.rec.length === 9 && m.rec[8] === 0x77, 'TAPOON and TAPOUT record a block');
// lines and the two kinds of fault (a line held, a pin disconnected), on the HB-55P (16K of RAM at C000h in slot 0)
{ const z = new ctx.MSXMachine(); for (const c of r.chunks) z.bios.set(c.bytes, c.addr); z.hasBios = true; z.reset();
  const N = z.nets();
  ok(N.D3.pins.join() === 'IC41,D3,IC42,O3,IC43,O3,IC44,O3,IC61,DIN,IC61,DOUT' && N.AB5.pins.length === 3 && N.MA0.pins.length === 8 && !N.MA7, 'HB-55P lines: D3 joins the Z80, the three ROMs and one RAM chip; AB5 the three ROMs; seven RAM address lines');
  z.setMachine('hb75p'); ok(z.nets().MA7.pins.length === 8 && z.chipById.IC58.part === '4164', 'HB-75P: 64K chips with an eighth address line'); z.setMachine('hb55p'); z.reset();
  z.write(0xC010, 0x5A); const r0 = z.read(0x0100);
  z.setNetFault('D3', 1); ok(z.read(0xC010) === 0x5A && z.read(0x0100) === (r0 | 8) && z.read(0xC011) === (z.ram[0xC011] | 8), 'D3 held high: bit 3 reads high from the ROM and the RAM');
  ok(z.chipById.IC61.f.DOUT === 1 && z.chipById.IC42.f.O3 === 1 && z.z80c.f.D3 === 1, 'the held line shows on every pin on it');
  z.write(0xC020, 0x00); z.clearFaults(); ok(z.read(0xC020) === 0x08, 'D3 held high while writing: the RAM stores the bit high');
  z.setPinFault('IC61', 'DOUT', 0); ok(z.read(0xC010) === 0x52 && z.read(0x0100) === r0, 'one RAM chip\'s DOUT disconnected at low: only RAM reads lose bit 3');
  z.clearFaults(); ok(z.read(0xC010) === 0x5A && !z.fx && !z.faulty, 'clearing the faults restores the machine');
  z.setPinFault('IC41', 'A14', 0); ok(z.read(0xC010) === z.read(0x8010) || z.peek(0x8010) === 0xFF, 'Z80 A14 stuck low: C000h reads from 8000h'); ok(z.busA(0xC010) === 0x8010, 'and the address on the bus is 8010h');
  z.clearFaults(); z.setPinFault('IC41', 'D0', 1); ok(z.read(0x0100) === (r0 | 1) && (z.input(0xA8) & 1) === 1, 'Z80 D0 stuck high: every memory and port read has bit 0 set');
  z.clearFaults(); z.setPinFault('IC41', 'WR', 'z'); z.write(0xC030, 0x77); z.clearFaults(); ok(z.read(0xC030) !== 0x77, 'Z80 WR disconnected: writes are lost');
  z.setPinFault('IC41', 'RD', 'z'); ok(z.read(0x0100) === 0xFF, 'Z80 RD disconnected: reads float to FFh'); z.clearFaults();
  z.setNetFault('CAS', 1); z.write(0xC040, 0x12); ok(z.read(0xC040) === 0xFF, 'main RAM CAS line held high: the RAM is out of circuit'); z.clearFaults();
  z.setPinFault('IC41', 'CLK', 0); ok(/clock/.test(z.held()) && z.cpu.step()[0].held && z.cpu.pc === 0, 'Z80 CLK stuck: the processor is held'); z.clearFaults(); ok(z.held() === null, 'and runs again once cleared');
  z.setPinFault('IC41', 'INT', 0); z.syncInt(); ok(z.cpu.intLine, 'Z80 INT stuck low: the interrupt line is on'); z.clearFaults(); z.syncInt(); ok(!z.cpu.intLine, 'and off again once cleared');
  z.setNetFault('D7', 0); z.setPinFault('IC61', 'A3', 'z'); ok(z.faultList().length === 2 && z.chipFaults('IC41').join() === 'D7: line held low', 'faults are listed as lines and as pins');
  z.clearChip('IC42'); ok(z.faultList().length === 1, "clearing a chip's faults releases the lines its pins are on");
  z.setMachine('hb75p'); ok(z.faultList().length === 0, 'changing the machine clears the faults'); }
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
