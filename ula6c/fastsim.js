// ---- ZX Spectrum ULA 6C001: the same event-driven simulation as ula6c/sim.js, compiled for speed ----
// Same cells, same delays, same inertial rule and the same order of events, so it gives the same answers as sim.js
// (ula6c/tb.js runs on either: ULA_ENGINE=fast). The netlist is turned into flat arrays; time is counted in
// 1/140 ns, so the 14 MHz oscillator's half period (35.714 ns = 5000) and every delay are whole numbers.
// API (times in ns): set(net, level), get(net), runTo(t), at(t, fn), watch[net] = fn(level, t), drivesPin(net).

const ULA6C_TICK = 140;                            // ticks per ns

class Ula6cFast {
  constructor(text, opts = {}) {
    const D = Object.assign({ buf_ef: 4, inv: 1.7, nor: 1.4, or: 1.4, ff: 5, pin: 3, xtal: 1 }, opts.delay || {});
    const els = [];
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
      const f = line.split(/\s+/), at = f.findIndex(x => x[0] === '@'); const w = at < 0 ? f : f.slice(0, at);
      const id = w[0], type = w[1]; let outs, ins;
      const colon = w.indexOf(':');
      if (colon >= 0) { outs = w.slice(2, colon); ins = w.slice(colon + 1); }
      else if (/^(tffs|ctr|lat|dff2)$/.test(type)) { outs = w.slice(2, 4); ins = w.slice(4); }
      else { outs = [w[2]]; ins = w.slice(3); }
      els.push({ id, type, outs, inv: ins.map(n => n[0] === '~'), ins: ins.map(n => n.replace(/^~/, '')) });
    }
    // nets: 0 = GND, 1 = VCC, 2 = unconnected ('-', reads 0)
    const netId = new Map([['GND', 0], ['VCC', 1], ['-', 2]]), names = ['GND', 'VCC', '-'];
    const nid = n => { if (!netId.has(n)) { netId.set(n, names.length); names.push(n); } return netId.get(n); };
    for (const e of els) { e.outs.forEach(nid); e.ins.forEach(nid); }
    const NN = names.length; this.netId = netId; this.names = names;
    const T = { buf_ef: 1, xtal: 1, inv: 2, nor: 3, or: 4, pin_ts: 5, oc: 6, ocn: 7, g4: 8, tapecell: 9, venc: 10, tffs: 11, ctr: 12, lat: 13, dff2: 14 };
    const NE = els.length;
    this.typ = new Uint8Array(NE); this.del = new Float64Array(NE); this.ci = new Uint8Array(NE);
    this.inS = new Int32Array(NE + 1); const inN = [], inI = [];
    this.outS = new Int32Array(NE + 1); const outN = [];
    for (let k = 0; k < NE; k++) {
      const e = els[k], t = /^n?or\d+$/.test(e.type) ? e.type.replace(/\d+$/, '') : e.type;
      this.typ[k] = T[t] || 0;
      this.del[k] = Math.round(ULA6C_TICK * (t === 'xtal' ? D.xtal : /^(tffs|ctr|lat|dff2)$/.test(t) ? D.ff : /^(pin_ts|oc|ocn)$/.test(t) ? D.pin
        : t === 'buf_ef' ? D.buf_ef : t === 'inv' ? D.inv : t === 'nor' ? D.nor : t === 'or' ? D.or : 2));
      this.ci[k] = t === 'tffs' ? 0 : t === 'ctr' ? 2 : t === 'lat' ? 1 : 2;
      this.inS[k] = inN.length; e.ins.forEach((n, i) => { inN.push(netId.get(n)); inI.push(e.inv[i] ? 1 : 0); });
      this.outS[k] = outN.length; e.outs.forEach(n => outN.push(netId.get(n)));
    }
    this.inS[NE] = inN.length; this.outS[NE] = outN.length;
    this.inN = Int32Array.from(inN); this.inI = Uint8Array.from(inI); this.outN = Int32Array.from(outN);
    const NO = outN.length;
    // per output: pending event, the level it drives (0, 1, or 2 = lets go), whether open collector
    this.pend = new Int32Array(NO).fill(-1); this.drv = new Uint8Array(NO).fill(2); this.outEl = new Int32Array(NO);
    for (let k = 0; k < NE; k++) for (let o = this.outS[k]; o < this.outS[k + 1]; o++) this.outEl[o] = k;
    this.state = new Uint8Array(NE); this.lastClk = new Uint8Array(NE);
    // fanout and drivers
    const fan = Array.from({ length: NN }, () => []), drv = Array.from({ length: NN }, () => []);
    for (let k = 0; k < NE; k++) {
      for (let i = this.inS[k]; i < this.inS[k + 1]; i++) { const n = this.inN[i]; if (n > 2 && !fan[n].includes(k)) fan[n].push(k); }
      for (let o = this.outS[k]; o < this.outS[k + 1]; o++) { const n = this.outN[o]; if (n !== 2) drv[n].push(o); }
    }
    const flat = (a) => { const s = new Int32Array(NN + 1), v = []; for (let n = 0; n < NN; n++) { s[n] = v.length; v.push(...a[n]); } s[NN] = v.length; return [s, Int32Array.from(v)]; };
    [this.fanS, this.fanE] = flat(fan); [this.drvS, this.drvO] = flat(drv);
    this.multi = new Uint8Array(NN); for (let n = 0; n < NN; n++) this.multi[n] = drv[n].length > 1 ? 1 : 0;
    this.pin = new Uint8Array(NN); for (let n = 0; n < NN; n++) this.pin[n] = /^PN\d+_/.test(names[n]) ? 1 : 0;
    this.isOC = new Uint8Array(NO); for (let o = 0; o < NO; o++) { const t = this.typ[this.outEl[o]]; this.isOC[o] = t === 6 || t === 7 ? 1 : 0; }
    // net levels; outside levels (2 = not set)
    this.v = new Uint8Array(NN); this.ext = new Uint8Array(NN).fill(2);
    this.v[1] = 1;
    const driven = new Uint8Array(NN); for (const o of outN) driven[o] = 1;
    for (let n = 3; n < NN; n++) if (!driven[n]) { this.v[n] = 1; this.ext[n] = 1; }     // undriven inputs: pins, high
    // the event queue: a binary heap of event slots, ordered by time then by when they were made
    this.cap = 4096; this.eT = new Float64Array(this.cap); this.eS = new Float64Array(this.cap); this.eO = new Int32Array(this.cap);
    this.eV = new Uint8Array(this.cap); this.eDead = new Uint8Array(this.cap); this.eCb = new Array(this.cap);
    this.free = []; for (let i = this.cap - 1; i >= 0; i--) this.free.push(i);
    this.heap = new Int32Array(this.cap); this.hn = 0; this.seq = 0; this.tk = 0; this.events = 0;
    this.wfn = new Array(NN).fill(null);
    const self = this, wobj = Object.create(null);
    this.watch = new Proxy(wobj, { set(o, k, f) { o[k] = f; const n = self.netId.get(k); if (n !== undefined) self.wfn[n] = f || null; return true; },
      deleteProperty(o, k) { delete o[k]; const n = self.netId.get(k); if (n !== undefined) self.wfn[n] = null; return true; } });
    this.els = els;
    for (let k = 0; k < NE; k++) this.update(k);
    this.runTo(500);
  }
  get t() { return this.tk / ULA6C_TICK; }
  // ---- the heap ----
  alloc() {
    if (!this.free.length) {
      const c = this.cap * 2, g = (A) => { const b = new A.constructor(c); b.set(A); return b; };
      this.eT = g(this.eT); this.eS = g(this.eS); this.eO = g(this.eO); this.eV = g(this.eV); this.eDead = g(this.eDead); this.heap = g(this.heap);
      this.eCb.length = c; for (let i = c - 1; i >= this.cap; i--) this.free.push(i); this.cap = c;
    }
    return this.free.pop();
  }
  lt(a, b) { const ta = this.eT[a], tb = this.eT[b]; return ta < tb || (ta === tb && this.eS[a] < this.eS[b]); }
  push(x) { const h = this.heap; let i = this.hn++; while (i) { const p = (i - 1) >> 1; if (this.lt(h[p], x)) break; h[i] = h[p]; i = p; } h[i] = x; }
  pop() {
    const h = this.heap, top = h[0], last = h[--this.hn];
    if (this.hn) { let i = 0; const n = this.hn; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && this.lt(h[c + 1], h[c])) c++; if (this.lt(last, h[c])) break; h[i] = h[c]; i = c; } h[i] = last; }
    return top;
  }
  // ---- cells ----
  inp(i) { const n = this.inN[i]; const x = n === 2 ? 0 : this.v[n]; return this.inI[i] ? 1 - x : x; }
  schedule(o, val) {
    if (this.outN[o] === 2) return;
    const p = this.pend[o];
    if (p >= 0) { if (this.eV[p] === val) return; this.eDead[p] = 1; this.pend[o] = -1; }
    if (val === this.drv[o]) return;
    const x = this.alloc(); this.eT[x] = this.tk + this.del[this.outEl[o]]; this.eS[x] = this.seq++; this.eO[x] = o; this.eV[x] = val; this.eDead[x] = 0; this.eCb[x] = null;
    this.pend[o] = x; this.push(x);
  }
  update(k) {
    const t = this.typ[k], s = this.inS[k], n = this.inS[k + 1] - s, o = this.outS[k];
    switch (t) {
      case 1: this.schedule(o, this.inp(s)); return;
      case 2: this.schedule(o, 1 - this.inp(s)); return;
      case 3: { let r = 1; for (let i = 0; i < n; i++) if (this.inp(s + i)) { r = 0; break; } this.schedule(o, r); return; }
      case 4: { let r = 0; for (let i = 0; i < n; i++) if (this.inp(s + i)) { r = 1; break; } this.schedule(o, r); return; }
      case 5: this.schedule(o, this.inp(s + 1) ? this.inp(s) : 2); return;
      case 6: this.schedule(o, this.inp(s) ? 2 : 0); return;
      case 7: this.schedule(o, this.inp(s) ? 0 : 2); return;
      case 8: { const C = this.inp(s), NG = this.inp(s + 1), NE = this.inp(s + 2), NF = this.inp(s + 3); this.schedule(o, ((NF | NE) & (1 - C)) | ((1 - NG) & (1 - NE) & (1 - NF))); return; }
      case 9: this.schedule(o, this.inp(s + n - 1)); return;
      case 10: { for (let q = o; q < this.outS[k + 1]; q++) this.schedule(q, 2); return; }
      case 11: case 12: case 13: case 14: {
        const clk = this.inp(s + this.ci[k]), rose = clk && !this.lastClk[k]; this.lastClk[k] = clk;
        if (t === 13) { if (clk) this.state[k] = this.inp(s); }
        else if (rose) {
          if (t === 11) this.state[k] = this.inp(s + 1) ? 0 : 1 - this.state[k];
          else if (t === 12) { const E = this.inp(s), NE = this.inp(s + 1), R = this.inp(s + 3), Q = this.state[k]; this.state[k] = R ? 0 : ((Q && !NE) || (!E && !Q)) ? 0 : 1; }
          else this.state[k] = this.inp(s) | this.inp(s + 1);
        }
        this.schedule(o, this.state[k]); this.schedule(o + 1, 1 - this.state[k]);
        return;
      }
      default: for (let q = o; q < this.outS[k + 1]; q++) this.schedule(q, 0);
    }
  }
  resolve(n) {
    if (!this.multi[n] && !this.pin[n]) { const s = this.drvS[n]; if (s === this.drvS[n + 1]) return this.ext[n] === 2 ? 0 : this.ext[n]; const d = this.drv[this.drvO[s]]; return d === 2 ? (this.ext[n] === 2 ? 0 : this.ext[n]) : d; }
    let any = 0, v = 0;
    for (let i = this.drvS[n]; i < this.drvS[n + 1]; i++) { const o = this.drvO[i], d = this.drv[o]; if (d === 2) continue; if (this.isOC[o]) return 0; any = 1; v |= d; }
    if (!any) return this.ext[n] !== 2 ? this.ext[n] : (this.pin[n] ? 1 : 0);
    return v;
  }
  change(n, val) {
    if (this.v[n] === val) return; this.v[n] = val;
    const w = this.wfn[n]; if (w) w(val, this.tk / ULA6C_TICK);
    for (let i = this.fanS[n]; i < this.fanS[n + 1]; i++) this.update(this.fanE[i]);
  }
  // ---- the outside ----
  set(name, val) { const n = this.netId.get(name); if (n === undefined) return; this.ext[n] = val; this.change(n, this.resolve(n)); }
  get(name) { const n = this.netId.get(name); return n === undefined ? undefined : this.v[n]; }
  drivesPin(name) {    // does a chip cell drive this pin net now (rather than let it go)?
    const n = this.netId.get(name); for (let i = this.drvS[n]; i < this.drvS[n + 1]; i++) if (this.drv[this.drvO[i]] !== 2) return true; return false;
  }
  at(t, cb) { const x = this.alloc(); this.eT[x] = Math.max(Math.round(t * ULA6C_TICK), this.tk); this.eS[x] = this.seq++; this.eO[x] = -1; this.eDead[x] = 0; this.eCb[x] = cb; this.push(x); }
  runTo(t) {
    const T = Math.round(t * ULA6C_TICK);
    while (this.hn && this.eT[this.heap[0]] <= T) {
      const x = this.pop(); this.free.push(x);
      if (this.eDead[x]) continue;
      this.tk = this.eT[x];
      if (this.eO[x] < 0) { const cb = this.eCb[x]; this.eCb[x] = null; cb(); continue; }
      this.events++;
      const o = this.eO[x]; this.pend[o] = -1; this.drv[o] = this.eV[x];
      const n = this.outN[o]; this.change(n, this.resolve(n));
    }
    if (T > this.tk) this.tk = T;
  }
}

if (typeof module !== 'undefined') module.exports = { Ula6cFast, ULA6C_TICK };
