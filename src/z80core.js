// ---- Z80 CPU core with machine-cycle bus logging ----
const FS = 0x80, FZ = 0x40, F5 = 0x20, FH = 0x10, F3 = 0x08, FPV = 0x04, FN = 0x02, FC = 0x01;
const SZ53 = new Uint8Array(256), SZ53P = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  SZ53[i] = (i & 0xA8) | (i ? 0 : FZ);
  let p = i; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1;
  SZ53P[i] = SZ53[i] | ((p & 1) ? 0 : FPV);
}
const sgn = v => (v & 0x80) ? v - 256 : v;

class Z80 {
  constructor(bus) {
    this.bus = bus;
    this.log = true;
    this.cyc = [];
    this.nmiPending = false;
    this.intLine = false;
    this.intVector = 0xFF;
    this.reset();
  }
  reset() {
    this.a = 0xFF; this.f = 0xFF; this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a_ = this.f_ = this.b_ = this.c_ = this.d_ = this.e_ = this.h_ = this.l_ = 0;
    this.ix = this.iy = 0xFFFF; this.sp = 0xFFFF; this.pc = 0; this.i = 0; this.r = 0;
    this.iff1 = this.iff2 = 0; this.im = 0; this.halted = false; this.eiDelay = false;
    this.nmiPending = false;
  }
  snapshot() {
    const s = {};
    for (const k of ['a','f','b','c','d','e','h','l','a_','f_','b_','c_','d_','e_','h_','l_','ix','iy','sp','pc','i','r','iff1','iff2','im','halted']) s[k] = this[k];
    return s;
  }
  // pairs
  get bc() { return (this.b << 8) | this.c; } set bc(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  get de() { return (this.d << 8) | this.e; } set de(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  get hl() { return (this.h << 8) | this.l; } set hl(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  get af() { return (this.a << 8) | this.f; } set af(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }

  // ---- bus cycles ----
  fetch() {
    const a = this.pc, v = this.bus.read(a);
    if (this.log) this.cyc.push({ k: 'M1', a, d: v, rf: (this.i << 8) | this.r });
    this.pc = (a + 1) & 0xFFFF;
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
    return v;
  }
  mr(a) { a &= 0xFFFF; const v = this.bus.read(a); if (this.log) this.cyc.push({ k: 'MR', a, d: v }); return v; }
  mw(a, v) { a &= 0xFFFF; v &= 0xFF; this.bus.write(a, v); if (this.log) this.cyc.push({ k: 'MW', a, d: v }); }
  imm() { const v = this.mr(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  imm16() { const lo = this.imm(); return (this.imm() << 8) | lo; }
  idle(n) { if (this.log) this.cyc.push({ k: 'ID', n }); }
  ioIn(p) { p &= 0xFFFF; const v = this.bus.input(p) & 0xFF; if (this.log) this.cyc.push({ k: 'IR', a: p, d: v }); return v; }
  ioOut(p, v) { p &= 0xFFFF; v &= 0xFF; this.bus.output(p, v); if (this.log) this.cyc.push({ k: 'IW', a: p, d: v }); }
  push(v) { this.sp = (this.sp - 1) & 0xFFFF; this.mw(this.sp, v >> 8); this.sp = (this.sp - 1) & 0xFFFF; this.mw(this.sp, v); }
  pop() { const lo = this.mr(this.sp); this.sp = (this.sp + 1) & 0xFFFF; const hi = this.mr(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return (hi << 8) | lo; }

  // ---- register access with IX/IY substitution ----
  getR(i, xy) {
    switch (i) {
      case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
      case 4: return xy === 1 ? this.ix >> 8 : xy === 2 ? this.iy >> 8 : this.h;
      case 5: return xy === 1 ? this.ix & 0xFF : xy === 2 ? this.iy & 0xFF : this.l;
      case 7: return this.a;
    }
  }
  setR(i, v, xy) {
    v &= 0xFF;
    switch (i) {
      case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
      case 4: if (xy === 1) this.ix = (this.ix & 0xFF) | (v << 8); else if (xy === 2) this.iy = (this.iy & 0xFF) | (v << 8); else this.h = v; break;
      case 5: if (xy === 1) this.ix = (this.ix & 0xFF00) | v; else if (xy === 2) this.iy = (this.iy & 0xFF00) | v; else this.l = v; break;
      case 7: this.a = v; break;
    }
  }
  getHL(xy) { return xy === 1 ? this.ix : xy === 2 ? this.iy : this.hl; }
  setHL(v, xy) { v &= 0xFFFF; if (xy === 1) this.ix = v; else if (xy === 2) this.iy = v; else this.hl = v; }
  getRP(p, xy) { return p === 0 ? this.bc : p === 1 ? this.de : p === 2 ? this.getHL(xy) : this.sp; }
  setRP(p, v, xy) { v &= 0xFFFF; if (p === 0) this.bc = v; else if (p === 1) this.de = v; else if (p === 2) this.setHL(v, xy); else this.sp = v; }
  getRP2(p, xy) { return p === 3 ? this.af : this.getRP(p, xy); }
  setRP2(p, v, xy) { if (p === 3) this.af = v & 0xFFFF; else this.setRP(p, v, xy); }
  idxAddr(xy) {
    if (!xy) return this.hl;
    const d = sgn(this.imm()); this.idle(5);
    return ((xy === 1 ? this.ix : this.iy) + d) & 0xFFFF;
  }
  cond(y) {
    const f = this.f;
    switch (y) {
      case 0: return !(f & FZ); case 1: return !!(f & FZ); case 2: return !(f & FC); case 3: return !!(f & FC);
      case 4: return !(f & FPV); case 5: return !!(f & FPV); case 6: return !(f & FS); case 7: return !!(f & FS);
    }
  }

  // ---- ALU ----
  add8(v, cy) {
    const a = this.a, r = a + v + cy, r8 = r & 0xFF;
    this.f = SZ53[r8] | ((a ^ v ^ r) & FH) | ((~(a ^ v) & (a ^ r) & 0x80) ? FPV : 0) | ((r >> 8) & FC);
    this.a = r8;
  }
  sub8(v, cy, store) {
    const a = this.a, r = a - v - cy, r8 = r & 0xFF;
    const f = (r8 & 0x80) | (r8 ? 0 : FZ) | FN | ((a ^ v ^ r) & FH) | (((a ^ v) & (a ^ r) & 0x80) ? FPV : 0) | ((r & 0x100) ? FC : 0);
    if (store) { this.f = f | (r8 & 0x28); this.a = r8; } else this.f = f | (v & 0x28);
  }
  alu(op, v) {
    switch (op) {
      case 0: this.add8(v, 0); break;
      case 1: this.add8(v, this.f & FC); break;
      case 2: this.sub8(v, 0, true); break;
      case 3: this.sub8(v, this.f & FC, true); break;
      case 4: this.a &= v; this.f = SZ53P[this.a] | FH; break;
      case 5: this.a ^= v; this.f = SZ53P[this.a]; break;
      case 6: this.a |= v; this.f = SZ53P[this.a]; break;
      case 7: this.sub8(v, 0, false); break;
    }
  }
  inc8(v) { const r = (v + 1) & 0xFF; this.f = (this.f & FC) | SZ53[r] | ((r & 0x0F) ? 0 : FH) | (r === 0x80 ? FPV : 0); return r; }
  dec8(v) { const r = (v - 1) & 0xFF; this.f = (this.f & FC) | FN | SZ53[r] | ((v & 0x0F) ? 0 : FH) | (v === 0x80 ? FPV : 0); return r; }
  rot(op, v) {
    let r, c;
    switch (op) {
      case 0: c = v >> 7; r = ((v << 1) | c) & 0xFF; break;
      case 1: c = v & 1; r = (v >> 1) | (c << 7); break;
      case 2: c = v >> 7; r = ((v << 1) | (this.f & FC)) & 0xFF; break;
      case 3: c = v & 1; r = (v >> 1) | ((this.f & FC) << 7); break;
      case 4: c = v >> 7; r = (v << 1) & 0xFF; break;
      case 5: c = v & 1; r = (v >> 1) | (v & 0x80); break;
      case 6: c = v >> 7; r = ((v << 1) | 1) & 0xFF; break;
      case 7: c = v & 1; r = v >> 1; break;
    }
    this.f = SZ53P[r] | c;
    return r;
  }
  bit(y, v, src35) {
    const t = v & (1 << y);
    this.f = (this.f & FC) | FH | (t ? 0 : (FZ | FPV)) | (t & 0x80) | (src35 & 0x28);
  }
  add16(a, v) {
    const r = a + v;
    this.f = (this.f & (FS | FZ | FPV)) | (((a ^ v ^ r) >> 8) & FH) | ((r >> 8) & 0x28) | ((r >> 16) & FC);
    return r & 0xFFFF;
  }
  adc16(v) {
    const a = this.hl, r = a + v + (this.f & FC), r16 = r & 0xFFFF;
    this.f = ((r16 >> 8) & 0xA8) | (r16 ? 0 : FZ) | (((a ^ v ^ r) >> 8) & FH) | ((~(a ^ v) & (a ^ r) & 0x8000) ? FPV : 0) | ((r >> 16) & FC);
    this.hl = r16;
  }
  sbc16(v) {
    const a = this.hl, r = a - v - (this.f & FC), r16 = r & 0xFFFF;
    this.f = ((r16 >> 8) & 0xA8) | (r16 ? 0 : FZ) | (((a ^ v ^ r) >> 8) & FH) | (((a ^ v) & (a ^ r) & 0x8000) ? FPV : 0) | FN | ((r & 0x10000) ? FC : 0);
    this.hl = r16;
  }
  daa() {
    const a = this.a, f = this.f;
    let corr = 0, c = f & FC;
    if ((f & FH) || (a & 0x0F) > 9) corr |= 0x06;
    if (c || a > 0x99) { corr |= 0x60; c = FC; }
    let r, h;
    if (f & FN) { h = ((f & FH) && (a & 0x0F) < 6) ? FH : 0; r = (a - corr) & 0xFF; }
    else { h = ((a & 0x0F) > 9) ? FH : 0; r = (a + corr) & 0xFF; }
    this.a = r; this.f = SZ53P[r] | h | (f & FN) | c;
  }

  // ---- one instruction (or interrupt response); returns machine-cycle log ----
  step() {
    this.cyc = [];
    const blockInt = this.eiDelay; this.eiDelay = false;
    if (this.nmiPending) {
      this.nmiPending = false; this.halted = false;
      this.iff1 = 0;
      const a = this.pc, v = this.bus.read(a);
      if (this.log) this.cyc.push({ k: 'M1', a, d: v, rf: (this.i << 8) | this.r });
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this.idle(1); this.push(this.pc); this.pc = 0x0066;
      this.lastEvent = 'NMI';
      return this.cyc;
    }
    if (this.intLine && this.iff1 && !blockInt) {
      this.halted = false; this.iff1 = this.iff2 = 0;
      const vec = this.intVector & 0xFF;
      if (this.log) this.cyc.push({ k: 'IA', a: this.pc, d: vec, rf: (this.i << 8) | this.r });
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      this.idle(1);
      if (this.im === 2) {
        this.push(this.pc);
        const t = (this.i << 8) | vec;
        const lo = this.mr(t), hi = this.mr(t + 1);
        this.pc = (hi << 8) | lo;
      } else if (this.im === 1) {
        this.push(this.pc); this.pc = 0x0038;
      } else {
        // IM 0: supports an RST opcode placed on the data bus
        this.push(this.pc); this.pc = ((vec & 0xC7) === 0xC7) ? (vec & 0x38) : 0x0038;
      }
      this.lastEvent = 'INT';
      return this.cyc;
    }
    this.lastEvent = null;
    if (this.halted) {
      const a = this.pc, v = this.bus.read(a);
      if (this.log) this.cyc.push({ k: 'M1', a, d: v, rf: (this.i << 8) | this.r, halt: true });
      this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
      return this.cyc;
    }
    let op = this.fetch(), xy = 0;
    while (op === 0xDD || op === 0xFD) { xy = op === 0xDD ? 1 : 2; op = this.fetch(); }
    if (op === 0xCB) {
      if (xy) {
        const base = xy === 1 ? this.ix : this.iy;
        const addr = (base + sgn(this.imm())) & 0xFFFF;
        const o = this.mr(this.pc); this.pc = (this.pc + 1) & 0xFFFF; this.idle(2);
        this.execCBIdx(o, addr);
      } else this.execCB(this.fetch());
    } else if (op === 0xED) this.execED(this.fetch());
    else this.execMain(op, xy);
    return this.cyc;
  }

  execMain(op, xy) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 0) {
      switch (z) {
        case 0:
          if (y === 0) {}
          else if (y === 1) { let t = this.a; this.a = this.a_; this.a_ = t; t = this.f; this.f = this.f_; this.f_ = t; }
          else if (y === 2) { this.idle(1); const d = sgn(this.imm()); this.b = (this.b - 1) & 0xFF; if (this.b) { this.idle(5); this.pc = (this.pc + d) & 0xFFFF; } }
          else if (y === 3) { const d = sgn(this.imm()); this.idle(5); this.pc = (this.pc + d) & 0xFFFF; }
          else { const d = sgn(this.imm()); if (this.cond(y - 4)) { this.idle(5); this.pc = (this.pc + d) & 0xFFFF; } }
          break;
        case 1:
          if (!q) this.setRP(p, this.imm16(), xy);
          else { this.idle(7); this.setHL(this.add16(this.getHL(xy), this.getRP(p, xy)), xy); }
          break;
        case 2: {
          if (!q) {
            if (p === 0) this.mw(this.bc, this.a);
            else if (p === 1) this.mw(this.de, this.a);
            else if (p === 2) { const n = this.imm16(), v = this.getHL(xy); this.mw(n, v & 0xFF); this.mw(n + 1, v >> 8); }
            else this.mw(this.imm16(), this.a);
          } else {
            if (p === 0) this.a = this.mr(this.bc);
            else if (p === 1) this.a = this.mr(this.de);
            else if (p === 2) { const n = this.imm16(); const lo = this.mr(n), hi = this.mr(n + 1); this.setHL((hi << 8) | lo, xy); }
            else this.a = this.mr(this.imm16());
          }
          break;
        }
        case 3: this.idle(2); this.setRP(p, this.getRP(p, xy) + (q ? -1 : 1), xy); break;
        case 4: case 5: {
          if (y === 6) { const ad = this.idxAddr(xy); const v = this.mr(ad); this.idle(1); this.mw(ad, z === 4 ? this.inc8(v) : this.dec8(v)); }
          else { const v = this.getR(y, xy); this.setR(y, z === 4 ? this.inc8(v) : this.dec8(v), xy); }
          break;
        }
        case 6:
          if (y === 6) {
            if (xy) { const d = sgn(this.imm()); const n = this.imm(); this.idle(2); this.mw(((xy === 1 ? this.ix : this.iy) + d) & 0xFFFF, n); }
            else this.mw(this.hl, this.imm());
          } else this.setR(y, this.imm(), xy);
          break;
        case 7: {
          const a = this.a, f = this.f;
          switch (y) {
            case 0: this.a = ((a << 1) | (a >> 7)) & 0xFF; this.f = (f & (FS | FZ | FPV)) | (this.a & 0x28) | (a >> 7); break;
            case 1: this.a = ((a >> 1) | (a << 7)) & 0xFF; this.f = (f & (FS | FZ | FPV)) | (this.a & 0x28) | (a & 1); break;
            case 2: this.a = ((a << 1) | (f & FC)) & 0xFF; this.f = (f & (FS | FZ | FPV)) | (this.a & 0x28) | (a >> 7); break;
            case 3: this.a = ((a >> 1) | ((f & FC) << 7)) & 0xFF; this.f = (f & (FS | FZ | FPV)) | (this.a & 0x28) | (a & 1); break;
            case 4: this.daa(); break;
            case 5: this.a = a ^ 0xFF; this.f = (f & (FS | FZ | FPV | FC)) | FH | FN | (this.a & 0x28); break;
            case 6: this.f = (f & (FS | FZ | FPV)) | FC | (a & 0x28); break;
            case 7: this.f = (f & (FS | FZ | FPV)) | ((f & FC) ? FH : FC) | (a & 0x28); break;
          }
          break;
        }
      }
    } else if (x === 1) {
      if (y === 6 && z === 6) { this.halted = true; }
      else if (y === 6) { const ad = this.idxAddr(xy); this.mw(ad, this.getR(z, 0)); }
      else if (z === 6) { const ad = this.idxAddr(xy); this.setR(y, this.mr(ad), 0); }
      else this.setR(y, this.getR(z, xy), xy);
    } else if (x === 2) {
      this.alu(y, z === 6 ? this.mr(this.idxAddr(xy)) : this.getR(z, xy));
    } else {
      switch (z) {
        case 0: this.idle(1); if (this.cond(y)) this.pc = this.pop(); break;
        case 1:
          if (!q) this.setRP2(p, this.pop(), xy);
          else if (p === 0) this.pc = this.pop();
          else if (p === 1) {
            let t;
            t = this.b; this.b = this.b_; this.b_ = t; t = this.c; this.c = this.c_; this.c_ = t;
            t = this.d; this.d = this.d_; this.d_ = t; t = this.e; this.e = this.e_; this.e_ = t;
            t = this.h; this.h = this.h_; this.h_ = t; t = this.l; this.l = this.l_; this.l_ = t;
          }
          else if (p === 2) this.pc = this.getHL(xy);
          else { this.idle(2); this.sp = this.getHL(xy); }
          break;
        case 2: { const n = this.imm16(); if (this.cond(y)) this.pc = n; break; }
        case 3:
          switch (y) {
            case 0: this.pc = this.imm16(); break;
            case 2: { const n = this.imm(); this.ioOut((this.a << 8) | n, this.a); break; }
            case 3: { const n = this.imm(); this.a = this.ioIn((this.a << 8) | n); break; }
            case 4: {
              const lo = this.mr(this.sp), hi = this.mr(this.sp + 1); this.idle(1);
              const v = this.getHL(xy); this.mw(this.sp + 1, v >> 8); this.mw(this.sp, v & 0xFF); this.idle(2);
              this.setHL((hi << 8) | lo, xy); break;
            }
            case 5: { const t = this.de; this.de = this.hl; this.hl = t; break; }
            case 6: this.iff1 = this.iff2 = 0; break;
            case 7: this.iff1 = this.iff2 = 1; this.eiDelay = true; break;
          }
          break;
        case 4: { const n = this.imm16(); if (this.cond(y)) { this.idle(1); this.push(this.pc); this.pc = n; } break; }
        case 5:
          if (!q) { this.idle(1); this.push(this.getRP2(p, xy)); }
          else if (p === 0) { const n = this.imm16(); this.idle(1); this.push(this.pc); this.pc = n; }
          break;
        case 6: this.alu(y, this.imm()); break;
        case 7: this.idle(1); this.push(this.pc); this.pc = y << 3; break;
      }
    }
  }

  execCB(op) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    if (z === 6) {
      const ad = this.hl, v = this.mr(ad); this.idle(1);
      if (x === 1) { this.bit(y, v, v); return; }
      this.mw(ad, x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y));
      return;
    }
    const v = this.getR(z, 0);
    if (x === 0) this.setR(z, this.rot(y, v), 0);
    else if (x === 1) this.bit(y, v, v);
    else if (x === 2) this.setR(z, v & ~(1 << y), 0);
    else this.setR(z, v | (1 << y), 0);
  }
  execCBIdx(op, ad) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    const v = this.mr(ad); this.idle(1);
    if (x === 1) { this.bit(y, v, ad >> 8); return; }
    const r = x === 0 ? this.rot(y, v) : x === 2 ? v & ~(1 << y) : v | (1 << y);
    this.mw(ad, r);
    if (z !== 6) this.setR(z, r, 0);
  }

  execED(op) {
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 1) {
      switch (z) {
        case 0: { const v = this.ioIn(this.bc); this.f = (this.f & FC) | SZ53P[v]; if (y !== 6) this.setR(y, v, 0); break; }
        case 1: this.ioOut(this.bc, y === 6 ? 0 : this.getR(y, 0)); break;
        case 2: this.idle(7); if (!q) this.sbc16(this.getRP(p, 0)); else this.adc16(this.getRP(p, 0)); break;
        case 3: {
          const n = this.imm16();
          if (!q) { const v = this.getRP(p, 0); this.mw(n, v & 0xFF); this.mw(n + 1, v >> 8); }
          else { const lo = this.mr(n), hi = this.mr(n + 1); this.setRP(p, (hi << 8) | lo, 0); }
          break;
        }
        case 4: { const v = this.a; this.a = 0; this.sub8(v, 0, true); break; }
        case 5: this.pc = this.pop(); this.iff1 = this.iff2; break;
        case 6: this.im = [0, 0, 1, 2, 0, 0, 1, 2][y]; break;
        case 7:
          switch (y) {
            case 0: this.idle(1); this.i = this.a; break;
            case 1: this.idle(1); this.r = this.a; break;
            case 2: this.idle(1); this.a = this.i; this.f = (this.f & FC) | SZ53[this.a] | (this.iff2 ? FPV : 0); break;
            case 3: this.idle(1); this.a = this.r; this.f = (this.f & FC) | SZ53[this.a] | (this.iff2 ? FPV : 0); break;
            case 4: { const v = this.mr(this.hl); this.idle(4); this.mw(this.hl, ((this.a << 4) | (v >> 4)) & 0xFF); this.a = (this.a & 0xF0) | (v & 0x0F); this.f = (this.f & FC) | SZ53P[this.a]; break; }
            case 5: { const v = this.mr(this.hl); this.idle(4); this.mw(this.hl, ((v << 4) | (this.a & 0x0F)) & 0xFF); this.a = (this.a & 0xF0) | (v >> 4); this.f = (this.f & FC) | SZ53P[this.a]; break; }
          }
          break;
      }
    } else if (x === 2 && z <= 3 && y >= 4) {
      const inc = (y & 1) ? -1 : 1, rep = y >= 6;
      if (z === 0) { // LDI/LDD/LDIR/LDDR
        const v = this.mr(this.hl); this.mw(this.de, v); this.idle(2);
        this.hl = this.hl + inc; this.de = this.de + inc; this.bc = this.bc - 1;
        const n = (v + this.a) & 0xFF;
        this.f = (this.f & (FS | FZ | FC)) | (this.bc ? FPV : 0) | (n & F3) | ((n & 0x02) ? F5 : 0);
        if (rep && this.bc) { this.idle(5); this.pc = (this.pc - 2) & 0xFFFF; }
      } else if (z === 1) { // CPI/CPD/CPIR/CPDR
        const v = this.mr(this.hl); this.idle(5);
        const r = (this.a - v) & 0xFF, h = (this.a ^ v ^ r) & FH;
        this.hl = this.hl + inc; this.bc = this.bc - 1;
        const n = (r - (h ? 1 : 0)) & 0xFF;
        this.f = (this.f & FC) | FN | (r & 0x80) | (r ? 0 : FZ) | h | (this.bc ? FPV : 0) | (n & F3) | ((n & 0x02) ? F5 : 0);
        if (rep && this.bc && r) { this.idle(5); this.pc = (this.pc - 2) & 0xFFFF; }
      } else if (z === 2) { // INI/IND/INIR/INDR
        this.idle(1); const v = this.ioIn(this.bc); this.mw(this.hl, v);
        this.b = (this.b - 1) & 0xFF; this.hl = this.hl + inc;
        this.f = (SZ53[this.b] & ~FPV) | FN | (this.f & FC);
        if (rep && this.b) { this.idle(5); this.pc = (this.pc - 2) & 0xFFFF; }
      } else { // OUTI/OUTD/OTIR/OTDR
        this.idle(1); const v = this.mr(this.hl); this.b = (this.b - 1) & 0xFF;
        this.ioOut(this.bc, v); this.hl = this.hl + inc;
        this.f = (SZ53[this.b] & ~FPV) | FN | (this.f & FC);
        if (rep && this.b) { this.idle(5); this.pc = (this.pc - 2) & 0xFFFF; }
      }
    }
    // all other ED opcodes behave as an 8-T NOP
  }
}

// ---- Disassembler ----
const DR = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const DRP = ['BC', 'DE', 'HL', 'SP'], DRP2 = ['BC', 'DE', 'HL', 'AF'];
const DCC = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const DALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const DROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];
const DBLK = [['LDI', 'CPI', 'INI', 'OUTI'], ['LDD', 'CPD', 'IND', 'OUTD'], ['LDIR', 'CPIR', 'INIR', 'OTIR'], ['LDDR', 'CPDR', 'INDR', 'OTDR']];
const h2 = v => v.toString(16).toUpperCase().padStart(2, '0');
const h4 = v => v.toString(16).toUpperCase().padStart(4, '0');

// rec: optional array; when given, operands become placeholders ({n} {nn} {d} {e})
// and every byte read is recorded with its role (used to build the assembler's table).
function disasm(read, addr, rec) {
  let pc = addr, kind = 'fix';
  const rd = () => { const v = read(pc & 0xFFFF); if (rec) rec.push(kind === 'fix' ? v : kind); pc++; return v; };
  const as = (k, f) => { kind = k; const v = f(); kind = 'fix'; return v; };
  const n8 = () => rec ? (as('n', rd), '{n}') : h2(rd()) + 'h';
  const n16 = () => { if (rec) { as('nl', rd); as('nh', rd); return '{nn}'; } const lo = rd(); return h4((rd() << 8) | lo) + 'h'; };
  let op = rd(), xy = 0, text;
  while ((op === 0xDD || op === 0xFD) && pc - addr < 4) { xy = op === 0xDD ? 1 : 2; op = rd(); }
  const IX = ['HL', 'IX', 'IY'][xy];
  const disp = () => { if (rec) { as('d', rd); return '(' + IX + '+{d})'; } const d = sgn(rd()); return '(' + IX + (d < 0 ? '-' : '+') + h2(Math.abs(d)) + 'h)'; };
  const reg = (i, allowIdx) => {
    if (i === 6) return xy ? disp() : '(HL)';
    if (allowIdx && xy && i === 4) return IX + 'H';
    if (allowIdx && xy && i === 5) return IX + 'L';
    return DR[i];
  };
  const rp = p => p === 2 ? IX : DRP[p];
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
  if (op === 0xCB) {
    let dstr = '', o;
    if (xy) { dstr = disp(); o = rd(); } else o = rd();
    const cx = o >> 6, cy = (o >> 3) & 7, cz = o & 7;
    const target = xy ? dstr : DR[cz];
    const tail = (xy && cz !== 6 && cx !== 1) ? ',' + DR[cz] : '';
    if (cx === 0) text = DROT[cy] + ' ' + target + tail;
    else text = ['', 'BIT', 'RES', 'SET'][cx] + ' ' + cy + ',' + target + tail;
  } else if (op === 0xED) {
    const o = rd(), ex = o >> 6, ey = (o >> 3) & 7, ez = o & 7, ep = ey >> 1, eq = ey & 1;
    if (ex === 1) {
      switch (ez) {
        case 0: text = ey === 6 ? 'IN (C)' : 'IN ' + DR[ey] + ',(C)'; break;
        case 1: text = ey === 6 ? 'OUT (C),0' : 'OUT (C),' + DR[ey]; break;
        case 2: text = (eq ? 'ADC' : 'SBC') + ' HL,' + DRP[ep]; break;
        case 3: text = eq ? 'LD ' + DRP[ep] + ',(' + n16() + ')' : 'LD (' + n16() + '),' + DRP[ep]; break;
        case 4: text = 'NEG'; break;
        case 5: text = ey === 1 ? 'RETI' : 'RETN'; break;
        case 6: text = 'IM ' + [0, 0, 1, 2, 0, 0, 1, 2][ey]; break;
        case 7: text = ['LD I,A', 'LD R,A', 'LD A,I', 'LD A,R', 'RRD', 'RLD', 'NOP', 'NOP'][ey]; break;
      }
    } else if (ex === 2 && ez <= 3 && ey >= 4) text = DBLK[ey - 4][ez];
    else text = 'NOP*';
  } else if (x === 0) {
    switch (z) {
      case 0: {
        if (y === 0) text = 'NOP';
        else if (y === 1) text = "EX AF,AF'";
        else { const d = sgn(rec ? as('e', rd) : rd()); const t = rec ? '{e}' : h4((pc + d) & 0xFFFF) + 'h';
          text = y === 2 ? 'DJNZ ' + t : y === 3 ? 'JR ' + t : 'JR ' + DCC[y - 4] + ',' + t; }
        break;
      }
      case 1: text = q ? 'ADD ' + IX + ',' + rp(p) : 'LD ' + rp(p) + ',' + n16(); break;
      case 2: text = [['LD (BC),A', 'LD (DE),A', null, null], ['LD A,(BC)', 'LD A,(DE)', null, null]][q][p];
        if (!text) text = p === 2 ? (q ? 'LD ' + IX + ',(' + n16() + ')' : 'LD (' + n16() + '),' + IX) : (q ? 'LD A,(' + n16() + ')' : 'LD (' + n16() + '),A');
        break;
      case 3: text = (q ? 'DEC ' : 'INC ') + rp(p); break;
      case 4: text = 'INC ' + reg(y, true); break;
      case 5: text = 'DEC ' + reg(y, true); break;
      case 6: { const t = reg(y, true); text = 'LD ' + t + ',' + n8(); break; }
      case 7: text = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'][y]; break;
    }
  } else if (x === 1) {
    if (y === 6 && z === 6) text = 'HALT';
    else { const mem = y === 6 || z === 6; text = 'LD ' + reg(y, !mem) + ',' + reg(z, !mem); }
  } else if (x === 2) text = DALU[y] + reg(z, true);
  else {
    switch (z) {
      case 0: text = 'RET ' + DCC[y]; break;
      case 1: text = !q ? 'POP ' + (p === 2 ? IX : DRP2[p]) : ['RET', 'EXX', 'JP (' + IX + ')', 'LD SP,' + IX][p]; break;
      case 2: text = 'JP ' + DCC[y] + ',' + n16(); break;
      case 3: text = [() => 'JP ' + n16(), null, () => 'OUT (' + n8() + '),A', () => 'IN A,(' + n8() + ')', () => 'EX (SP),' + IX, () => 'EX DE,HL', () => 'DI', () => 'EI'][y](); break;
      case 4: text = 'CALL ' + DCC[y] + ',' + n16(); break;
      case 5: text = !q ? 'PUSH ' + (p === 2 ? IX : DRP2[p]) : 'CALL ' + n16(); break;
      case 6: text = DALU[y] + n8(); break;
      case 7: text = 'RST ' + h2(y << 3) + 'h'; break;
    }
  }
  return { len: pc - addr, text };
}

if (typeof module !== 'undefined') module.exports = { Z80, disasm, h2, h4 };
