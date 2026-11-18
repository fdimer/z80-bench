// Amstrad CPC model checks. The timing and memory checks need no ROM; the boot check needs your own ROM images:
//   CPC_ROMS=/folder/with/OS_464.ROM/and/BASIC_1.0.ROM node tests/cpc-test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'memchips.js', 'cpc.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', f), 'utf8') + '\nthis.Z80 = Z80; this.CPCMachine = typeof CPCMachine !== "undefined" ? CPCMachine : undefined; this.CPC = typeof CPC !== "undefined" ? CPC : undefined; this.CPCTape = typeof CPCTape !== "undefined" ? CPCTape : undefined; this.memSetFault = typeof memSetFault !== "undefined" ? memSetFault : undefined;', ctx);
const { CPCMachine, CPC } = ctx;
// a fault on one pin: the pin disconnected from its line ('z': floating; 0 or 1: at that level), or an output stuck at a level
const memSetFault = (m, id, pin, v) => m.setPinFault(id, pin, v);
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
{ // sound: registers written through the 8255 (port A data, port C bits 7-6 the bus control), 1 MHz clock
  const m = new CPCMachine(); m.gaMode = 0x0C; m.audioRate = 48000;     // NOPs in RAM
  const reg = (r, v) => { m.output(0xF400, r); m.output(0xF600, 0xC0); m.output(0xF600, 0); m.output(0xF400, v); m.output(0xF600, 0x80); m.output(0xF600, 0); };
  m.output(0xF700, 0x82);
  const cycles = (buf, from, to) => { let n = 0; for (let i = from + 1; i < to; i++) if (buf[i & 32767] > buf[(i - 1) & 32767]) n++; return n; };   // rising edges
  reg(0, 142); reg(1, 0); reg(4, 71); reg(5, 0); reg(7, 0x3A); reg(8, 15); reg(10, 15);     // A 440 Hz, C 880 Hz, B off, no noise
  ok('sound registers written through the 8255', m.psg[0] === 142 && m.psg[7] === 0x3A && m.psg[8] === 15);
  m.run(400000); let a0 = m.aw; m.run(4000000); let a1 = m.aw;
  ok('one second of samples', Math.abs(a1 - a0 - 48000) <= 2, a1 - a0);
  const fl = cycles(m.abufL, a0, Math.min(a1, a0 + 32000)) * 48000 / Math.min(a1 - a0, 32000), fr = cycles(m.abufR, a0, Math.min(a1, a0 + 32000)) * 48000 / Math.min(a1 - a0, 32000);
  ok('tone A (period 142) on the left: 440 Hz', Math.abs(fl - 62500 / 142) < 4, fl.toFixed(1)); ok('tone C (period 71) on the right: 880 Hz', Math.abs(fr - 62500 / 71) < 8, fr.toFixed(1));
  ok('note names', CPCMachine.note(142) === 'A4' && CPCMachine.note(71) === 'A5');
  memSetFault(m, 'IC116', 'CCLK', 0); m.run(40000); a0 = m.aw; m.run(400000);
  ok('no CCLK: the sound chip stands still', !m.soundClock() && cycles(m.abufL, a0, m.aw) === 0); memSetFault(m, 'IC116', 'CCLK', null);
  m.run(400000); ok('CCLK back: sound again', m.soundClock() && cycles(m.abufL, m.aw - 4000, m.aw) > 20);
  m.reset(); ok('reset clears the sound chip', m.psg.every(v => v === 0));
}
{ // cassette: a small tape built here. A turbo block (2 pilot pulses of 1000, syncs 500/600, bits 300/600), a pause, a stop, a pure tone
  const { CPCTape } = ctx, hdr = [...'ZXTape!'].map(c => c.charCodeAt(0)).concat([0x1A, 1, 20]);
  const w = v => [v & 255, v >> 8];
  const tzx = new Uint8Array(hdr.concat([0x11], w(1000), w(500), w(600), w(300), w(600), w(2), [8], w(10), [1, 0, 0], [0xA5],
    [0x20], w(0), [0x12], w(700), w(3), [0x30, 4], [...'test'].map(c => c.charCodeAt(0))));
  const tp = new CPCTape(tzx), k = 8 / 7, near = (c, t) => Math.abs(c - t * k) <= 1;
  ok('tape: pulses for pilot, sync, 8 bits, the pause edge, the pause, the tone', tp.n === 2 + 2 + 16 + 2 + 3, tp.n);
  ok('tape: lengths scaled from 3.5 to 4 MHz', near(tp.dur[0], 1000) && near(tp.dur[2], 500) && near(tp.dur[4], 600) && near(tp.dur[5], 600) && near(tp.dur[6], 300), [...tp.dur.subarray(0, 8)].join());
  ok('tape: levels alternate, starting high', [...tp.lvl.subarray(0, 20)].every((l, i) => l === (i & 1 ? 0 : 1)));
  ok('tape: pause = 1 ms at the opposite level, then low', near(tp.dur[20], 3500) && tp.lvl[20] === 1 && near(tp.dur[21], 9 * 3500) && tp.lvl[21] === 0, tp.dur[20] + ' ' + tp.lvl[20]);
  ok('tape: blocks listed (the data, the stop, the pulses after it), a text note', tp.blocks.length === 3 && /tone/.test(tp.blocks[2].desc) && /turbo block, 1 bytes/.test(tp.blocks[0].desc) && tp.stops.has(22) && tp.notes.includes('test'), tp.blocks.map(b => b.desc).join('; '));
  const m = new CPCMachine(); m.gaMode = 0x0C; m.insertTape(tzx);
  const inB = () => m.input(0xF500) >> 7 & 1;
  ok('tape: port B bit 7 reads the tape (high for the first pulse)', inB() === 1);
  m.tapePlay = true; m.run(40000); ok('tape: no motor, no movement', m.tapeIdx === 0 && m.tapePos === 0);
  m.output(0xF700, 0x82); m.output(0xF600, 0x10); ok('tape: motor on through port C bit 4', m.motorOn());
  const seen = []; for (let i = 0; i < 20000 && m.tapeIdx < 20; i++) { m.step(); if (seen[seen.length - 1] !== inB()) seen.push(inB()); }
  ok('tape: the level follows the pulses as it plays', seen.length >= 20, seen.length);
  m.run(400000); ok('tape: the stop block releases PLAY', !m.tapePlay && m.tapeIdx === 22, m.tapeIdx);
  m.tapePlay = true; m.run(40000); ok('tape: played to the end', !m.tapePlay && m.tapeIdx >= tp.n);
  m.tapeSeek(0); ok('tape: rewind', m.tapeIdx === 0 && m.tapePos === 0 && inB() === 1);
  { // instant loading: a firmware data record (sync 16h, one 256-byte segment and its CRC) read through CAS READ
    const seg = Array.from({ length: 256 }, (_, i) => (i * 7 + 3) & 255); let crc = 0xFFFF;
    for (const v of seg) { crc ^= v << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF; }
    crc = ~crc & 0xFFFF; const rec = [0x16, ...seg, crc >> 8, crc & 255, 255, 255, 255, 255];
    const tzx2 = new Uint8Array(hdr.concat([0x11], w(2000), w(500), w(600), w(300), w(600), w(10), [8], w(100), [rec.length & 255, rec.length >> 8, 0], rec));
    const casCall = (bytes, hl, de) => {
      const x = new CPCMachine(); x.gaMode = 0x08; x.instant = true; x.insertTape(bytes);
      x.ram[0xBCA1] = 0xCF; x.ram[0xBCA2] = 0x36; x.ram[0xBCA3] = 0xA8;              // the firmware's jump block: CAS READ at 2836h
      x.ram[0xBFFE] = 0x34; x.ram[0xBFFF] = 0x12; x.cpu.sp = 0xBFFE; x.cpu.pc = 0x2836;
      x.cpu.h = hl >> 8; x.cpu.l = hl & 255; x.cpu.d = de >> 8; x.cpu.e = de & 255; x.cpu.a = 0x16; x.cpu.f = 0; x.preStep(); return x;
    };
    let x = casCall(tzx2, 0x4000, 200);
    ok('instant loading: CAS READ returns at once with carry set', x.cpu.pc === 0x1234 && x.cpu.sp === 0xC000 && (x.cpu.f & 1) === 1, x.cpu.pc.toString(16));
    ok('instant loading: the record is in RAM, only the length asked for', seg.slice(0, 200).every((v, i) => x.ram[0x4000 + i] === v) && x.ram[0x4000 + 200] === 0);
    ok('instant loading: the tape is wound past the record', x.tapeIdx === x.tape.blocks[0].end && x.tapeIdx > 0);
    const bad2 = tzx2.slice(); bad2[bad2.length - 6] ^= 1; x = casCall(bad2, 0x4000, 256);
    ok('instant loading: a CRC error returns carry clear, A = 2', x.cpu.pc === 0x1234 && (x.cpu.f & 1) === 0 && x.cpu.a === 2);
    x = casCall(tzx2, 0x4000, 256); x.cpu.a = 0x2C; x.tapeSeek(0); x.cpu.pc = 0x2836; x.cpu.sp = 0xBFFE; x.preStep();
    ok('instant loading: no record with that sync byte, so the firmware reads the signal', x.cpu.pc === 0x2836);
    x = casCall(tzx2, 0x4000, 256); x.tapeSeek(0); x.cpu.pc = 0x2836; x.cpu.sp = 0xBFFE; x.instant = false; x.preStep(); ok('instant loading off: nothing happens', x.cpu.pc === 0x2836);
  }
  let bad = false; try { new CPCTape(new Uint8Array(20)); } catch (e) { bad = /ZXTape/.test(e.message); } ok('tape: a file that is not a tape is refused', bad);
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
  // the Z80's input pins, and RESET as one line for the board
  m.gaMode = 0x0C; m.cpu.pc = 0x4000; memSetFault(m, 'IC111', 'WAIT', 0); m.run(400); ok('Z80 WAIT pin low: held', m.cpu.pc === 0x4000 && /WAIT/.test(m.held()));
  memSetFault(m, 'IC111', 'WAIT', 1); const w0 = m.waits; m.run(4000); ok('Z80 WAIT pin high: no wait states, whatever READY does', m.waits === w0 && m.cpu.pc !== 0x4000); memSetFault(m, 'IC111', 'WAIT', null);
  m.cpu.pc = 0x4000; m.cpu.iff1 = m.cpu.iff2 = 0; memSetFault(m, 'IC111', 'NMI', 0); m.step(); ok('Z80 NMI pin low: one NMI', m.cpu.pc === 0x66 || m.cpu.lastEvent === 'NMI'); m.step(); ok('only one', m.cpu.lastEvent !== 'NMI'); memSetFault(m, 'IC111', 'NMI', null);
  m.intReq = true; memSetFault(m, 'IC111', 'INT', 'z'); ok('Z80 INT pin disconnected: it never sees the request', m.intOut() === false); memSetFault(m, 'IC111', 'INT', 0); m.intReq = false; ok('Z80 INT pin low: a request all the time', m.intOut() === true); memSetFault(m, 'IC111', 'INT', null);
  m.cpu.pc = 0x4321; memSetFault(m, 'IC111', 'RESET', 0); m.run(40); ok('Z80 RESET pin low: held in reset at 0000h', m.cpu.pc === 0 && /RESET/.test(m.held())); memSetFault(m, 'IC111', 'RESET', null);
  m.gaMode = 0x0D; m.cpu.pc = 0x4321; m.hcc = 7; m.chipReset(); ok('RESET line: Z80, gate array and 6845 reset', m.cpu.pc === 0 && m.gaMode === 0 && m.hcc === 0);
  m.gaMode = 0x0D; m.cpu.pc = 0x4321; memSetFault(m, 'IC116', 'RESET', 'z'); memSetFault(m, 'IC111', 'RESET', 1); m.chipReset();
  ok('a chip whose RESET pin is high or disconnected is not reset', m.gaMode === 0x0D && m.cpu.pc === 0x4321); memSetFault(m, 'IC116', 'RESET', null); memSetFault(m, 'IC111', 'RESET', null);
  [63, 40, 46, 0x8E, 38, 0, 25, 30, 0, 7].forEach((v, r) => { m.output(0xBC00, r); m.output(0xBD00, v); }); m.gaMode = 0x0C; m.cpu.pc = 0x4000; m.run(400000);
  memSetFault(m, 'IC108', 'RESET', 0); m.run(4000); const f0 = m.frames; m.run(400000); ok('6845 RESET pin low: no sync, no frames', m.frames === f0 && !m.hs && !m.vsync && !m.de); memSetFault(m, 'IC108', 'RESET', null);
  ok('all cleared', !m.faulty && !m.gf && !m.busF && m.held() === null);
}
{ // a whole line held at a level, against one pin disconnected from it
  const m = new CPCMachine(); m.gaMode = 0x0C;
  m.setNetFault('RA6', 1);                                                          // RAM address line 6: CPU A8 (row) and A15 (column)
  ok('line held high: all eight RAM chips see it', CPC.RAM_ICS.every(ic => m.chipById['IC' + ic].f.A6 === 1) && Object.keys(m.chipById.IC116.f).length === 0);
  m.write(0x8100, 0xAB); ok('the whole byte folds', m.read(0x0000) === 0xAB && m.read(0x8000) === 0xAB);
  m.setPinFault('IC120', 'A6', 0);                                                  // this one chip's pin cut from the line and low
  ok('one pin disconnected from the held line keeps its own level', m.chipById.IC120.f.A6 === 0 && m.chipById.IC119.f.A6 === 1);
  m.write(0x0000, 0x01); ok('only that chip (bit 0) addresses differently', (m.ram[0x0000] & 1) === 1 && (m.ram[0x8100] & 0xFE) === 0x00, m.ram[0x0000] + ' ' + m.ram[0x8100]);
  ok('listed once each', m.faultList().length === 2 && /held high \(8 pins\)/.test(m.faultList()[0][2]) && /IC120 pin A6 disconnected from its line, at low/.test(m.faultList()[1][2]), JSON.stringify(m.faultList()));
  m.clearFaults(); ok('cleared', !m.faulty && m.faultList().length === 0 && Object.keys(m.chipById.IC120.f).length === 0);
  m.setNetFault('RD0', 1); m.ram[0x4000] = 0x00;
  ok('RAM data-out line held high: the RAM chip and the gate array pin both show it; the CPU reads it', m.chipById.IC120.f.DOUT === 1 && m.chipById.IC116.f.D0 === 1 && m.read(0x4000) === 0x01);
  m.setNetFault('RD0', null); m.setPinFault('IC120', 'DOUT', 'z'); ok('an output disconnected: the listening pin floats', m.chipById.IC116.f.D0 === 'z' && m.read(0x4000) === 0x01); m.clearFaults();
  m.setNetFault('A3', 0); ok('address line held low: Z80, ROM and the bus', m.z80.f.A3 === 0 && m.romChip.f.A3 === 0 && m.busA(0xFFFF) === 0xFFF7); m.clearFaults();
  m.cpu.pc = 0x4321; m.gaMode = 0x0D; m.setNetFault('RESET', 0); const t0 = m.t; m.run(4000);
  ok('RESET line held low: Z80, gate array and 6845 in reset, time goes on', m.cpu.pc === 0 && m.gaMode === 0 && m.t - t0 >= 4000 && /RESET/.test(m.held()));
  m.setPinFault('IC116', 'RESET', 'z'); m.output(0x7F00, 0x8D); ok('gate array\'s RESET pin disconnected from the held line: it works again', m.gaMode === 0x0D); m.clearFaults();
  m.setNetFault('INT', 0); ok('INT line held low: a request all the time', m.intOut() === true); m.setPinFault('IC111', 'INT', 'z'); ok('unless the Z80\'s pin is disconnected from it', m.intOut() === false); m.clearFaults();
  ok('drivers', m.isDriver('IC116', 'INT') && !m.isDriver('IC111', 'INT') && m.isDriver('IC111', 'A3') && !m.isDriver('IC111', 'D3') && m.netOf('IC108', 'CS') === 'A14' && m.netOf('IC116', 'R') === null);
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
  { // save a BASIC program to tape, then load it back from the recording
    const x = new CPCMachine(); x.rom.set(m.rom); x.hasLo = x.hasHi = true; x.run(4000000 * 3);
    const tk = (k, sh) => { if (sh) x.key('Shift', true); x.run(80000); x.key(k, true); x.run(240000); x.key(k, false); if (sh) x.key('Shift', false); x.run(80000); };
    const typeX = str => { for (const ch of str) { if (ch === '\n') tk('Return'); else if (ch === '"') tk('2', 1); else if (ch === ' ') tk('Space'); else tk(ch.toUpperCase()); } };
    typeX('10 PRINT "TAPE OK"\nSAVE "T"\n'); x.run(4000000);
    const asked = x.screenText().some(l => /REC and PLAY/.test(l));
    x.recStart(); tk('Space'); let i = 0; for (; i < 120 && !(i > 3 && !x.motorOn()); i++) x.run(4000000);
    const bytes = x.recStop(); x.run(4000000 * 2);
    ok('SAVE asks for REC and PLAY, and the recording becomes a CDT file', asked && bytes && bytes.length > 1000, bytes && bytes.length);
    typeX('NEW\nLOAD ""\n'); x.run(4000000); x.insertTape(bytes); x.tapePlay = true; tk('Space');
    for (i = 0; i < 120 && !(i > 3 && !x.motorOn()); i++) x.run(4000000);
    x.run(4000000); typeX('RUN\n'); x.run(4000000 * 2);
    const scr = x.screenText();
    { // and again with instant loading: no waiting for the tape
      const y = new CPCMachine(); y.rom.set(m.rom); y.hasLo = y.hasHi = true; y.run(4000000 * 3); y.instant = true;
      const tky = k => { y.run(80000); y.key(k, true); y.run(240000); y.key(k, false); y.run(80000); };
      for (const k of ['L', 'O', 'A', 'D', 'Space']) tky(k); y.key('Shift', true); tky('2'); tky('2'); y.key('Shift', false); tky('Return'); y.run(4000000);
      y.insertTape(bytes); tky('Space'); y.run(4000000 * 4);     // the firmware lets the motor run up to speed first
      for (const k of ['R', 'U', 'N', 'Return']) tky(k); y.run(4000000);
      const s2 = y.screenText();
      ok('instant loading: the recording loads at once once the motor is up to speed, without PLAY', y.casLoads >= 2 && s2.some(l => l.trim().toUpperCase() === 'TAPE OK'), y.casLoads + ' ' + s2.filter(l => l.trim()).slice(-4).join(' | '));
    }
    ok('the recording loads back: the program runs', scr.some(l => /Loading T block 1/.test(l)) && scr.some(l => l.trim().toUpperCase() === 'TAPE OK'), scr.filter(l => l.trim()).join(' | '));
  }
  if (process.env.CPC_TAPE) {   // load a real tape: CPC_TAPE=/path/to/file.cdt
    const x = new CPCMachine(); x.rom.set(m.rom); x.hasLo = x.hasHi = true; x.run(4000000 * 3);
    const tp = x.insertTape(new Uint8Array(fs.readFileSync(process.env.CPC_TAPE))), tk = (k, sh) => { if (sh) x.key('Shift', true); x.run(80000); x.key(k, true); x.run(240000); x.key(k, false); if (sh) x.key('Shift', false); x.run(80000); };
    for (const [k, sh] of [['R'], ['U'], ['N'], ['2', 1], ['2', 1], ['Return']]) tk(k, sh); x.run(4000000); x.tapePlay = true; tk('Space');
    for (let i = 0; i < 1200 && !(x.tapeIdx >= tp.n || (!x.tapePlay && i > 5)); i++) x.run(4000000);
    x.run(4000000 * 10); const scr = x.screenText();
    console.log('  tape ' + path.basename(process.env.CPC_TAPE) + ': ' + scr.filter(l => l.trim()).slice(0, 4).join(' | '));
    ok('tape loads into its last block without falling back to BASIC', x.tapeIdx >= tp.blocks[tp.blocks.length - 1].seg && !scr.includes('Ready'), x.tapeIdx + ' of ' + tp.n);
  }
  { m.audioRate = 48000; type('SOUND 1,142,200,15\n'); let hit = false; for (let i = 0; i < 40 && !hit; i++) { m.run(100000); hit = m.psg[0] === 142 && (m.psg[8] & 15) > 0 && !(m.psg[7] & 1); }
    ok('BASIC SOUND 1,142 plays tone A at 440 Hz', hit, [...m.psg].join(',')); m.audioRate = 0; }
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
