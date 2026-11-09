const { Z80SIO } = require('../src/z80sio.js');
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const AC = 1, AD = 0, BC = 3, BD = 2;   // sel: bit1 = B/A, bit0 = C/D
const s = new Z80SIO(); const tx = []; s.onTx = (c, v) => tx.push([c, v]);
const init = (c) => { s.write(c, 0x18); s.write(c, 4); s.write(c, 0xC4); s.write(c, 3); s.write(c, 0xC1); s.write(c, 5); s.write(c, 0xEA); };
init(AC); init(BC);
ok(s.read(AC) === 0x6C, 'RR0 after init: Tx empty, DCD, CTS, underrun = ' + s.read(AC).toString(16));
ok(s.ch[0].rtsPin() === 0 && s.ch[0].dtrPin() === 0, '/RTS and /DTR active');
// transmit 'A' (41h): 10 bits x 64 clocks = 640 clocks
s.write(AD, 0x41);
ok((s.read(AC) & 4) === 0, 'Tx buffer full after write');
s.clock(1); ok((s.read(AC) & 4) === 4, 'buffer empties once the shift register loads');
const lv = []; for (let i = 0; i < 639; i++) { if (i % 64 === 0) lv.push(s.ch[0].txd()); s.clock(1); }
ok(lv.join('') === '0100000101', 'TxD bit pattern start,LSB..MSB,stop = ' + lv.join(''));
ok(tx.length === 1 && tx[0][1] === 0x41, 'onTx delivered 41h after 640 clocks');
ok(s.read(AC) !== undefined && (s.ch[0].rr1() & 1) === 1, 'all sent');
// receive
s.ch[0].lineQ.push(0x48, 0x69);
s.clock(639); ok((s.read(AC) & 1) === 0, 'nothing yet after 639 clocks');
s.clock(1); ok((s.read(AC) & 1) === 1, 'char available after 640 clocks');
ok(s.read(AD) === 0x48, 'reads H'); s.clock(640); ok(s.read(AD) === 0x69, 'reads i');
// overrun: 5 chars without reading -> FIFO 3, overrun flag
s.ch[0].lineQ.push(1, 2, 3, 4, 5); s.clock(640 * 5);
s.write(AC, 1); const r1 = s.read(AC); ok((r1 & 0x20) === 0x20, 'overrun in RR1');
ok([s.read(AD), s.read(AD), s.read(AD)].join() === '1,2,5', 'FIFO keeps first two, last overwritten');
s.write(AC, 0x30); s.write(AC, 1); ok((s.read(AC) & 0x20) === 0, 'error reset clears overrun');
// 7E1 framing and 2 stop bits on channel B
s.write(BC, 4); s.write(BC, 0x4F); s.write(BC, 5); s.write(BC, 0xAA);  // x16, 2 stop, even parity; Tx 7 bits
s.write(BD, 0x43); const bl = []; for (let i = 0; i < 16 * 11; i++) { if (i % 16 === 8) bl.push(s.ch[1].txd()); s.clock(1); }
ok(bl.join('') === '01100001111', '7E1+2 stop pattern = ' + bl.join(''));
// interrupts: mode 2, status affects vector, Rx all chars, Tx int, on both channels
s.write(BC, 2); s.write(BC, 0x40);           // vector base 40h
s.write(BC, 1); s.write(BC, 0x17);           // B: ext, Tx int, status affects vector, Rx all chars
s.write(AC, 1); s.write(AC, 0x13);           // A: ext enable, Tx int, Rx all chars (parity affects)... (mode 2)
ok(!s.intRequest(), 'no request yet');
s.ch[1].lineQ.push(0x31); s.clock(16 * 11); ok(!s.intRequest(), "not yet at 11 bit times (frame is 12)"); s.clock(16);
ok(s.intRequest() && s.vector() === 0x44, 'B Rx available -> vector 44h, got ' + s.vector().toString(16));
s.ch[0].lineQ.push(0x32); s.clock(640);
ok(s.vector() === 0x4C, 'A Rx has priority -> 4Ch, got ' + s.vector().toString(16));
ok(s.ack() === 0x4C && !s.intRequest(), 'ack A Rx: under service blocks lower sources');
ok(s.ieo() === 0, 'IEO low while under service');
s.read(AD); s.m1(0xED); s.m1(0x4D);
ok(s.ius === 0 && s.intRequest() && s.vector() === 0x44, 'RETI (ED 4D) releases; B Rx now requests');
s.ack(); s.read(BD); s.m1(0xED); s.m1(0x4D); ok(!s.intRequest(), 'B serviced');
s.write(BD, 0x41); s.clock(1); ok(s.intRequest() && s.vector() === 0x40, 'B Tx empty -> 40h, got ' + s.vector().toString(16));
s.write(BC, 0x28); ok(!s.intRequest(), 'reset TxINT pending');
s.ch[0].setInput('cts', 1); ok(s.intRequest() && s.vector() === 0x4A, 'A ext/status (CTS change) -> 4Ah');
ok((s.read(AC) & 0x20) === 0, 'RR0 shows CTS inactive');
s.write(AC, 0x10); ok(!s.intRequest(), 'reset ext/status');
// auto enables: Tx waits for CTS
s.write(AC, 3); s.write(AC, 0xE1); s.write(AD, 0x55); s.clock(2000); const before = tx.length;
s.ch[0].setInput('cts', 0); s.write(AC, 0x10); s.clock(700); ok(tx.length === before + 1, 'auto enables: transmits once /CTS goes low');
// RTS flow control on the far end
s.flow[0] = true; s.write(AC, 5); s.write(AC, 0xE8); s.ch[0].lineQ.push(0x7A); s.clock(2000);
ok(s.ch[0].fifo.length === 0, 'far end holds while /RTS inactive');
s.write(AC, 5); s.write(AC, 0xEA); s.clock(700); ok(s.ch[0].fifo.length === 1, 'sends when /RTS active');
// first-char mode
s.read(AD); s.write(AC, 1); s.write(AC, 0x08); s.write(AC, 0x20);
s.ch[0].lineQ.push(1, 2); s.clock(640); ok(s.intRequest(), 'first char interrupts');
s.ack(); s.read(AD); s.m1(0xED); s.m1(0x4D); s.clock(640); ok(!s.intRequest() && s.ch[0].fifo.length === 1, 'second char does not');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
