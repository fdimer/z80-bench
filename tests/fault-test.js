// Memory-chip fault model checks (no ROM needed): node tests/fault-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'm6821.js', 'z80sio.js', 'osborne.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.Osborne = Osborne;', ctx);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const m = new ctx.Osborne(new Uint8Array(0x2000).fill(0xA5));
m.pa = 0x00;                                  // bank 0, ROM and video banks off
m.write(0x1234, 0xFF); ok(m.read(0x1234) === 0xFF && !m.faulty, 'no faults: RAM reads back');
m.setFault('U11', 'DOUT', 0); ok(m.read(0x1234) === 0xF7, '4164 DOUT stuck low clears that bit on reads');
m.setFault('U11', 'DOUT', null); ok(m.read(0x1234) === 0xFF && !m.faulty, 'the cell itself was not changed');
m.setFault('U13', 'DIN', 0); m.write(0x2000, 0xFF); m.setFault('U13', 'DIN', null); ok(m.read(0x2000) === 0xDF, '4164 DIN stuck low stores a 0');
m.setFault('U8', 'A4', 1); m.write(0x0000, 0x01); m.write(0x1010, 0x00);
ok((m.read(0x0000) & 1) === 0, '4164 address pin stuck: two addresses share one cell (row and column bit 4)');
m.setFault('U8', 'A4', null);
m.write(0x0004, 0x00); m.write(0x0000, 0x00); m.setFault('U8', 'A1', 1); m.write(0x0000, 0x01); m.setFault('U8', 'A1', null);
ok((m.read(0x0404) & 1) === 1 && (m.read(0x0000) & 1) === 0, 'RAM pin A1 carries A2 and A10 on the RD1140 board: stuck high, the write lands at 0404h');
m.setFault('U15', 'WE', 1); m.write(0x3000, 0x80); m.setFault('U15', 'WE', null); ok((m.read(0x3000) & 0x80) === 0, '4164 WE stuck high: the write is lost');
m.setFault('U9', 'RAS', 'z'); ok((m.read(0x3000) & 2) === 2, '4164 with RAS disconnected reads 1'); m.setFault('U9', 'RAS', null);
m.pa = 0x80;                                  // ROM bank on
ok(m.read(0x0100) === 0xA5, 'ROM reads'); m.setFault('UD18', 'O2', 0); ok(m.read(0x0100) === 0xA1, '2764 output stuck low');
m.setFault('UD18', 'O2', null); m.setFault('UD18', 'CE', 1); ok(m.read(0x0100) === 0xFF, '2764 chip enable stuck high: the bus floats'); m.setFault('UD18', 'CE', null);
m.write(0x2005, 0x3C); m.setFault('UD15', 'A0', 0); ok(m.read(0x2005) !== 0x3C || m.read(0x2004) === m.read(0x2005), '6116 address pin stuck low: odd addresses read the even cell'); m.setFault('UD15', 'A0', null);
m.pa = 0x40;                                  // video bank on
m.write(0xC010, 0x41); m.setFault('UC3', 'D0', 0); ok(m.read(0xC010) === 0x40, 'video RAM data pin stuck low');
const px = new Uint8Array(640 * 240); m.vidEna = true; m.renderFrame(px); ok(true, 'the display renders through the faulty chip');
m.setFault('UC3', 'D0', null); m.setFault('UC3', 'CE', 0); m.pa = 0; m.write(0x4010, 0xFF); m.vchar[0x010] = 0x0F;
ok(m.read(0x4010) === 0x0F, 'chip enable stuck low: the video RAM fights the DRAM on the bus (AND of the two)');
m.clearFaults(); ok(!m.faulty && m.read(0x4010) === 0xFF && m.faultList().length === 0, 'clearing the faults restores normal reads');
// ---- faults on P1, the RAM board's connector ----
vm.runInContext('this.OSB = OSB;', ctx);
m.pa = 0x00; m.write(0x1000, 0x5A); m.write(0x1200, 0x00);
m.setFault('P1', 'A9', 'z'); ok(m.faulty && m.read(0x1000) === 0x00, 'P1 A9 disconnected: the board sees A9 high, so 1000h reads the cell at 1200h');
m.write(0x1000, 0x77); m.setFault('P1', 'A9', null); ok(m.read(0x1000) === 0x5A && m.read(0x1200) === 0x77, 'and a write to 1000h lands at 1200h');
m.setFault('P1', 'D3', 0); m.write(0x2100, 0xFF); ok(m.read(0x2100) === 0xF7, 'P1 D3 stuck low: the bit reads 0'); m.setFault('P1', 'D3', null); ok(m.read(0x2100) === 0xF7, 'and was stored as 0');
m.dram[1][0x3000] = 0x11; m.dram[0][0x3000] = 0x22; m.dram[0][0xF800] = 0x33;
m.setFault('P1', 'PRI1', 'z'); ok(m.read(0x3000) === 0x11 && m.read(0xF800) === 0x33, 'P1 PRI1 disconnected: bank 1 answers below F000h whatever port A says, and F000h up is still bank 0'); m.setFault('P1', 'PRI1', null);
m.pa = 0x80; m.dram[1][0x0100] = 0x0F; ok(m.read(0x0100) === 0xA5, 'ROM bank on: the RAM board stands aside');
m.setFault('P1', 'ROMDEC', 'z'); ok(m.read(0x0100) === (0xA5 & m.dram[0][0x0100]), 'P1 ROMDEC* disconnected: the RAM board answers as well, and the bus carries the AND of ROM and RAM');
m.write(0x0100, 0x3C); ok(m.dram[0][0x0100] === 0x3C && m.font[0x100] === 0x3C, 'and a write goes to the font RAM and to the DRAM'); m.setFault('P1', 'ROMDEC', null);
m.pa = 0x00; m.write(0x4000, 0x99);
m.setFault('P1', 'ROMDEC', 0); ok(m.read(0x4000) === 0xFF, 'P1 ROMDEC* stuck low: the board never answers, reads float'); m.setFault('P1', 'ROMDEC', null);
m.setFault('P1', 'CAS', 1); m.write(0x4000, 0x00); ok(m.read(0x4000) === 0xFF, 'P1 CAS* stuck high: no cell is read'); m.setFault('P1', 'CAS', null); ok(m.read(0x4000) === 0x99, 'or written');
m.setFault('P1', 'RD', 0); m.write(0x4000, 0x00); m.setFault('P1', 'RD', null); ok(m.read(0x4000) === 0x99, 'P1 RD* stuck low: write enable never goes low, the write is lost');
m.setFault('P1', 'RD', 'z'); m.read(0x4000); m.setFault('P1', 'RD', null); ok(m.read(0x4000) === 0xFF, 'P1 RD* disconnected: every access is a write, a read overwrites the cell with 1s');
m.write(0x5512, 0x42); m.write(0x55FF, 0x24); m.setFault('P1', 'RAE', 1); ok(m.read(0x5512) === 0x24, 'P1 RAE* stuck high: the row address floats to FFh'); m.setFault('P1', 'RAE', null);
m.write(0x1234, 0x01); m.write(0x1210, 0xAB); m.setFault('P1', 'CAE', 0); ok(m.read(0x1234) === 0xAB, 'P1 CAE* stuck low: the row is the AND of the two address bytes, so 1234h reads the cell at 1210h'); m.setFault('P1', 'CAE', null);
m.write(0x6010, 0x12); m.write(0x6090, 0x34); m.setFault('P1', 'RFSH', 0); ok(m.read(0x6010) === 0x34, 'P1 RFSH* stuck low: row bit 7 comes from the refresh bit, 6010h reads the cell at 6090h'); m.setFault('P1', 'RFSH', null);
m.setFault('P1', 'MREQ', 'z'); ok(m.read(0x6010) === 0x12, 'P1 MREQ* disconnected: no effect'); m.setFault('P1', 'MREQ', null);
// refresh: run a small loop in bank 0 for longer than the RAMs hold their data
{ const run = t => { let n = 0; while (n < t) n += m.step(); };
  m.clearFaults(); m.reset(); m.pia0.onPA = () => {}; m.pa = 0x00;
  m.dram[0].fill(0); m.dram[1].fill(0x55); m.dram[0][0] = 0x18; m.dram[0][1] = 0xFE;      // JR $ at 0000h
  m.setFault('P1', 'D0', 0); run(3 * ctx.OSB.DRAM_HOLD_T); m.setFault('P1', 'D0', null);
  ok(m.dram[1][0x1234] === 0x55 && m.dram[0][0x4321] === 0x00, 'with a fault that leaves refresh alone, both banks keep their data');
  m.cpu.i = 0xFF; m.setFault('P1', 'RFSH', 'z'); run(3 * ctx.OSB.DRAM_HOLD_T); m.setFault('P1', 'RFSH', null);
  ok(m.dram[0][0x4321] === 0x00 && m.dram[0][0] === 0x18, 'P1 RFSH* disconnected, I = FFh: refresh still reaches bank 0 (its address is F000h up)');
  ok(m.dram[1][0x1234] === 0xFF && m.dram[1][0xE0FF] === 0xFF, 'but bank 1 gets no RAS and forgets');
  m.dram[0][0x4321] = 0x77; m.setFault('P1', 'RAS', 0); run(3 * ctx.OSB.DRAM_HOLD_T); m.setFault('P1', 'RAS', null);
  ok(m.dram[0][0x4321] === 0xFF, 'P1 RAS stuck low: nothing is refreshed and everything is forgotten'); }
m.clearFaults(); ok(!m.faulty && m.faultList().length === 0, 'all P1 faults cleared');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
