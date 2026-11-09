// Z80 SIO/2 (Z8440 family) model: two channels, asynchronous mode.
// Serial lines are bit-accurate (start, data, parity, stop bits timed in serial clock cycles).
// Interrupts follow the Z80 daisy-chain scheme: six sources in fixed priority, mode 2 vectors
// ("status affects vector"), interrupt acknowledge, and RETI decoded by watching M1 fetches.
class SIOChannel {
  constructor(id, sio) { this.id = id; this.sio = sio; this.cts = 0; this.dcd = 0; this.lineQ = []; this.reset(); }
  reset() {
    this.wr = [0, 0, 0, 0, 0, 0, 0, 0]; this.ptr = 0;
    this.fifo = []; this.lastRx = 0; this.errs = 0;
    this.txBuf = null; this.txShift = null; this.allSent = true; this.txUnderrun = true;
    this.txIP = false; this.rxIP = false; this.specialIP = false; this.extIP = false; this.extLatch = null;
    this.rxFirst = false; this.rxFrame = null;
  }
  // configuration decoded from the write registers
  rxBits() { return [5, 7, 6, 8][this.wr[3] >> 6]; }
  txBits() { return [5, 7, 6, 8][(this.wr[5] >> 5) & 3]; }
  mult() { return [1, 16, 32, 64][this.wr[4] >> 6]; }
  stop() { return [1, 1, 1.5, 2][(this.wr[4] >> 2) & 3]; }   // 00 selects sync modes, which are not emulated
  syncMode() { return ((this.wr[4] >> 2) & 3) === 0; }
  bitClocks() { return this.mult() * this.sio.clkDiv[this.id]; }
  autoEn() { return !!(this.wr[3] & 0x20); }
  txEnabled() { return !!(this.wr[5] & 0x08) && (!this.autoEn() || this.cts === 0); }
  rxEnabled() { return !!(this.wr[3] & 0x01) && (!this.autoEn() || this.dcd === 0); }
  rxIntMode() { return (this.wr[1] >> 3) & 3; }
  frame(v, n) {
    const bits = [[0, 1]]; let ones = 0;
    for (let i = 0; i < n; i++) { const b = (v >> i) & 1; ones += b; bits.push([b, 1]); }
    if (this.wr[4] & 1) bits.push([(this.wr[4] & 2) ? ones & 1 : (ones & 1) ^ 1, 1]);
    const s = this.stop(); bits.push([1, s]);
    return bits;
  }
  // pins
  txd() { if (this.wr[5] & 0x10) return 0; return this.txShift ? this.txShift.bits[this.txShift.idx][0] : 1; }
  rxd() { return this.rxFrame ? this.rxFrame.bits[this.rxFrame.idx][0] : 1; }
  rtsPin() { return this.wr[5] & 0x02 ? 0 : 1; }
  dtrPin() { return this.wr[5] & 0x80 ? 0 : 1; }
  // modem inputs from the outside world (pin levels: 0 = active)
  setInput(name, level) {
    const old = this[name]; this[name] = level ? 1 : 0;
    if (old !== this[name] && (this.wr[1] & 1) && !this.extIP) { this.extIP = true; this.extLatch = { cts: this.cts, dcd: this.dcd }; }
  }
  clock(n) {
    // transmitter
    let t = n;
    while (t > 0) {
      if (!this.txShift) {
        if (this.txBuf === null || !this.txEnabled()) break;
        const bits = this.frame(this.txBuf, this.txBits());
        this.txShift = { bits, idx: 0, left: bits[0][1] * this.bitClocks(), v: this.txBuf & ((1 << this.txBits()) - 1) };
        this.txBuf = null; this.allSent = false;
        if (this.wr[1] & 0x02) this.txIP = true;      // transmit buffer has become empty
      }
      const s = this.txShift, take = Math.min(t, s.left); s.left -= take; t -= take;
      if (s.left <= 0) {
        if (++s.idx >= s.bits.length) { this.txShift = null; if (this.txBuf === null) this.allSent = true; this.sio.onTx(this.id, s.v); }
        else s.left = Math.round(s.bits[s.idx][1] * this.bitClocks());
      }
    }
    // the far end sending to RxD, framed to match the receiver's settings
    let r = n;
    while (r > 0) {
      if (!this.rxFrame) {
        if (!this.lineQ.length || (this.sio.flow[this.id] && this.rtsPin())) break;
        const v = this.lineQ.shift(), bits = this.frame(v, this.rxBits());
        this.rxFrame = { bits, idx: 0, left: this.bitClocks(), v: v & ((1 << this.rxBits()) - 1) };
      }
      const f = this.rxFrame, take = Math.min(r, f.left); f.left -= take; r -= take;
      if (f.left <= 0) {
        if (++f.idx >= f.bits.length) { this.rxFrame = null; this.receive(f.v); }
        else f.left = Math.round(f.bits[f.idx][1] * this.bitClocks());
      }
    }
  }
  receive(v) {
    if (!this.rxEnabled()) return;
    const mode = this.rxIntMode();
    if (this.fifo.length >= 3) { this.fifo[2] = v; this.errs |= 0x20; if (mode) this.specialIP = true; }   // overrun
    else this.fifo.push(v);
    if (mode === 1 && this.rxFirst) { this.rxIP = true; this.rxFirst = false; }
    this.sio.onRx(this.id, v);
  }
  // CPU side
  readData() {
    if (this.fifo.length) this.lastRx = this.fifo.shift();
    if (this.rxIntMode() === 1) this.rxIP = false;
    return this.lastRx;
  }
  writeData(v) { this.txBuf = v & 0xFF; this.txIP = false; this.allSent = false; }
  rr0() {
    const l = this.extLatch || this;
    return (this.fifo.length ? 1 : 0) | (this.id === 0 && this.sio.anyPending() ? 2 : 0) | (this.txBuf === null ? 4 : 0) |
      (l.dcd === 0 ? 8 : 0) | (l.cts === 0 ? 0x20 : 0) | (this.txUnderrun ? 0x40 : 0);
  }
  rr1() { return (this.allSent && !this.txShift ? 1 : 0) | this.errs; }
  readCtrl() {
    const p = this.ptr; this.ptr = 0;
    return p === 1 ? this.rr1() : p === 2 ? this.sio.rr2() : this.rr0();
  }
  writeCtrl(v) {
    const p = this.ptr; this.ptr = 0;
    if (p) { if (p === 2) { if (this.id === 1) this.sio.wr2 = v; } else this.wr[p] = v; return; }
    this.ptr = v & 7;
    switch ((v >> 3) & 7) {
      case 2: this.extIP = false; this.extLatch = null; break;                 // reset ext/status interrupts
      case 3: { const ptr = this.ptr; this.reset(); this.ptr = ptr; this.sio.ius &= ~(this.id ? 0x38 : 0x07); break; }   // channel reset
      case 4: this.rxFirst = true; break;                                      // enable interrupt on next Rx character
      case 5: this.txIP = false; break;                                        // reset TxINT pending
      case 6: this.errs &= ~0x70; this.specialIP = false; break;                // error reset
      case 7: if (this.id === 0) this.sio.reti(); break;                       // return from interrupt
    }
    if ((v >> 6) === 3) this.txUnderrun = false;
  }
}

class Z80SIO {
  constructor() {
    this.clkDiv = [1, 1]; this.flow = [false, false];
    this.onTx = () => {}; this.onRx = () => {};
    this.ch = [new SIOChannel(0, this), new SIOChannel(1, this)];
    this.reset();
  }
  reset() { this.ch[0].reset(); this.ch[1].reset(); this.wr2 = 0; this.ius = 0; this.iei = 1; this.lastM1 = -1; }
  // CPU port access: sel bit 1 = B/A (1 = channel B), bit 0 = C/D (1 = control)
  read(sel) { const c = this.ch[(sel >> 1) & 1]; return sel & 1 ? c.readCtrl() : c.readData(); }
  write(sel, v) { const c = this.ch[(sel >> 1) & 1]; sel & 1 ? c.writeCtrl(v & 0xFF) : c.writeData(v & 0xFF); }
  clock(n) { if (n > 0) { this.ch[0].clock(n); this.ch[1].clock(n); } }
  // interrupt sources in priority order: A Rx, A Tx, A Ext, B Rx, B Tx, B Ext
  pending(s) {
    const c = this.ch[s < 3 ? 0 : 1];
    switch (s % 3) {
      case 0: { const m = c.rxIntMode(); return m !== 0 && (c.specialIP || (m === 1 ? c.rxIP : c.fifo.length > 0)); }
      case 1: return c.txIP && !!(c.wr[1] & 2);
      default: return c.extIP && !!(c.wr[1] & 1);
    }
  }
  anyPending() { for (let s = 0; s < 6; s++) if (this.pending(s)) return true; return false; }
  topIus() { for (let s = 0; s < 6; s++) if (this.ius & (1 << s)) return s; return 6; }
  requestSource() { if (!this.iei) return -1; const top = this.topIus(); for (let s = 0; s < top; s++) if (this.pending(s)) return s; return -1; }
  intRequest() { return this.requestSource() >= 0; }
  code(s) { const c = this.ch[s < 3 ? 0 : 1], k = s % 3; return (s < 3 ? 4 : 0) + (k === 0 ? (c.specialIP ? 3 : 2) : k === 1 ? 0 : 1); }
  vectorFor(s) { return this.ch[1].wr[1] & 4 ? (this.wr2 & 0xF1) | ((s < 0 ? 3 : this.code(s)) << 1) : this.wr2; }
  rr2() { let s = -1; for (let i = 0; i < 6; i++) if (this.pending(i)) { s = i; break; } return this.vectorFor(s); }
  ack() { const s = this.requestSource(); if (s < 0) return this.wr2; this.ius |= 1 << s; return this.vectorFor(s); }
  vector() { return this.vectorFor(this.requestSource()); }
  reti() { const s = this.topIus(); if (s < 6) this.ius &= ~(1 << s); }
  ieo() { return this.iei && !this.ius && !this.intRequest() ? 1 : 0; }
  m1(op) { if (this.lastM1 === 0xED && op === 0x4D) this.reti(); this.lastM1 = op; }   // RETI is ED 4D, both fetched with /M1 low
}
if (typeof module !== 'undefined') module.exports = { Z80SIO };
