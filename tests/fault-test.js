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
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
