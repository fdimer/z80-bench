// ---- ZX Spectrum ULA 6C001: event-driven gate-level simulation of ula6c/6c001.net ----
// One element per gate, flip-flop, latch or pin cell, each with a delay (inertial: a pulse shorter than the delay
// is swallowed). Time is in nanoseconds. The cell behaviours are the gate circuits of Ferranti drawings 6C001/2-/4,
// worked through by hand (see ula6c/README.md):
//   tffs  Q NQ  ~T R          toggles on the rising edge of its clock input as written (~T: the falling edge of T);
//                             R (synchronous) clears it on that edge instead
//   ctr   Q NQ  E NE ~CLK R   counter cell: on the clock edge  Q' = R ? 0 : !((Q && !NE) || (!E && !Q)),
//                             which toggles when E is high and NE low
//   lat   Q NQ  D ~C          data latch, transparent while its clock input as written is high (C low)
//   dff2  Q NQ  D1 D2 ~CLK    D flip-flop storing D1 OR D2 on the clock edge
//   g4    OUT   C NG NE NF    OUT = ((NF|NE) & !C) | (!NG & !NE & !NF)
//   pin_ts PIN  DATA ~EN      tri-state pin driver, drives while its enable as written is high
//   oc / ocn PIN DATA         open-collector pin driver (R38, OC1): pulls the pin low while DATA is low (oc) or high (ocn)
//   buf_ef / inv / nor<n> / or<n>, and xtal (the oscillator cell, a buffer from the OSC pin)
// A net driven by more than one element is a wired OR (emitter followers joined at a dot).
// Pins are nets: the outside sets input pins with set(); output pins are read with get(). On a pin, an open-collector
// pull-down wins over everything; a driving chip cell wins over the outside (the board's resistors); otherwise the pin
// takes what the outside set, or high (pulled up) if nothing was set.

const ULA6C_DELAY = { buf_ef: 4, inv: 1.7, nor: 1.4, or: 1.4, ff: 5, pin: 3, xtal: 1 };

class Ula6cSim {
  constructor(text, opts = {}) {
    this.delay = Object.assign({}, ULA6C_DELAY, opts.delay || {});
    this.v = Object.create(null); this.fan = Object.create(null); this.drivers = Object.create(null);
    this.els = []; this.ext = Object.create(null); this.t = 0; this.q = []; this.seq = 0; this.events = 0;
    this.watch = Object.create(null);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
      const f = line.split(/\s+/), at = f.findIndex(x => x[0] === '@'); const w = at < 0 ? f : f.slice(0, at);
      const id = w[0], type = w[1]; let outs, ins;
      const colon = w.indexOf(':');
      if (colon >= 0) { outs = w.slice(2, colon); ins = w.slice(colon + 1); }
      else if (/^(tffs|ctr|lat|dff2)$/.test(type)) { outs = w.slice(2, 4); ins = w.slice(4); }
      else { outs = [w[2]]; ins = w.slice(3); }
      this.els.push({ id, type, outs, inv: ins.map(n => n[0] === '~'), ins: ins.map(n => n.replace(/^~/, '')), grid: at < 0 ? '' : f[at].slice(1) });
    }
    for (const e of this.els) {
      const t = e.type;
      e.d = t === 'xtal' ? this.delay.xtal : /^(tffs|ctr|lat|dff2)$/.test(t) ? this.delay.ff : /^(pin_ts|oc|ocn)$/.test(t) ? this.delay.pin
        : t === 'buf_ef' ? this.delay.buf_ef : t === 'inv' ? this.delay.inv : /^nor/.test(t) ? this.delay.nor : /^or/.test(t) ? this.delay.or : 2;
      e.state = 0; e.pend = []; e.drive = e.outs.map(() => null); e.lastClk = 0; e.oc = t === 'oc' || t === 'ocn';
      for (const n of e.ins) if (n !== '-' && n !== 'VCC' && n !== 'GND') (this.fan[n] = this.fan[n] || []).push(e);
      e.outs.forEach((n, i) => { if (n !== '-') (this.drivers[n] = this.drivers[n] || []).push([e, i]); });
    }
    this.v.VCC = 1; this.v.GND = 0;
    for (const e of this.els) for (const n of e.outs) if (n !== '-') this.v[n] = 0;
    for (const e of this.els) for (const n of e.ins) if (n !== '-' && !(n in this.v)) { this.v[n] = 1; this.ext[n] = 1; }   // undriven inputs: pins
    for (const [n, val] of Object.entries(opts.init || {})) this.v[n] = val;
    if (opts.randomState) for (const e of this.els) if (/^(tffs|ctr|lat|dff2)$/.test(e.type)) e.state = Math.random() < 0.5 ? 1 : 0;
    this.settle();
  }
  isPin(n) { return /^PN\d+_/.test(n); }
  get(n) { return this.v[n]; }
  in(e, i) { const n = e.ins[i]; if (n === '-' || n === 'GND') return e.inv[i] ? 1 : 0; const x = n === 'VCC' ? 1 : this.v[n] | 0; return e.inv[i] ? 1 - x : x; }
  calc(e) {
    const t = e.type, n = e.ins.length;
    if (t === 'buf_ef' || t === 'xtal') return [this.in(e, 0)];
    if (t === 'inv') return [1 - this.in(e, 0)];
    if (/^nor/.test(t)) { for (let i = 0; i < n; i++) if (this.in(e, i)) return [0]; return [1]; }
    if (/^or/.test(t)) { for (let i = 0; i < n; i++) if (this.in(e, i)) return [1]; return [0]; }
    if (t === 'pin_ts') return [this.in(e, 1) ? this.in(e, 0) : null];
    if (t === 'oc') return [this.in(e, 0) ? null : 0];
    if (t === 'ocn') return [this.in(e, 0) ? 0 : null];
    if (t === 'g4') { const C = this.in(e, 0), NG = this.in(e, 1), NE = this.in(e, 2), NF = this.in(e, 3); return [((NF | NE) & (1 - C)) | ((1 - NG) & (1 - NE) & (1 - NF))]; }
    if (t === 'tapecell') return [this.in(e, e.ins.length - 1)];   // EAR follows the pin (threshold modelled by the testbench)
    if (t === 'venc') return e.outs.map(() => null);                // analogue: read through venc()
    return e.outs.map(() => 0);
  }
  update(e) {
    const t = e.type;
    if (/^(tffs|ctr|lat|dff2)$/.test(t)) {
      const ci = t === 'tffs' ? 0 : t === 'ctr' ? 2 : t === 'lat' ? 1 : 2;
      const clk = this.in(e, ci), rose = clk && !e.lastClk; e.lastClk = clk;
      if (t === 'lat') { if (clk) e.state = this.in(e, 0); }
      else if (rose) {
        if (t === 'tffs') e.state = this.in(e, 1) ? 0 : 1 - e.state;
        else if (t === 'ctr') { const E = this.in(e, 0), NE = this.in(e, 1), R = this.in(e, 3), Q = e.state; e.state = R ? 0 : ((Q && !NE) || (!E && !Q)) ? 0 : 1; }
        else if (t === 'dff2') e.state = this.in(e, 0) | this.in(e, 1);
      }
      this.schedule(e, 0, e.state); this.schedule(e, 1, 1 - e.state);
      return;
    }
    const r = this.calc(e); r.forEach((val, i) => this.schedule(e, i, val));
  }
  schedule(e, i, val) {
    const net = e.outs[i]; if (net === '-' || net === undefined) return;
    const p = e.pend[i];
    if (p && p.val === val) return;
    if (p) p.dead = true;
    e.pend[i] = null;
    if (val === e.drive[i] && !p) return;
    if (val === e.drive[i]) return;
    const ev = { t: this.t + e.d, s: this.seq++, e, i, val, dead: false }; e.pend[i] = ev; this.push(ev);
  }
  resolve(n) {
    // wired OR of the chip's drivers; a pin net also sees the outside while every chip driver lets go
    let any = false, v = 0;
    for (const [e, i] of this.drivers[n] || []) { const d = e.drive[i]; if (d === null) continue; if (e.oc) return 0; any = true; v |= d; }
    if (!any) return n in this.ext ? this.ext[n] : (this.isPin(n) ? 1 : 0);
    return v;
  }
  set(n, val) { this.ext[n] = val; this.change(n, this.resolve(n)); }
  change(n, val) {
    if (this.v[n] === val) return; this.v[n] = val;
    const w = this.watch[n]; if (w) w(val, this.t);
    for (const e of this.fan[n] || []) this.update(e);
  }
  push(ev) { const q = this.q; q.push(ev); let i = q.length - 1; while (i) { const p = (i - 1) >> 1; if (this.lt(q[p], ev)) break; q[i] = q[p]; i = p; } q[i] = ev; }
  lt(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  pop() { const q = this.q, top = q[0], last = q.pop(); if (q.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= q.length) break; if (c + 1 < q.length && this.lt(q[c + 1], q[c])) c++; if (this.lt(last, q[c])) break; q[i] = q[c]; i = c; } q[i] = last; } return top; }
  runTo(t) {
    while (this.q.length && this.q[0].t <= t) {
      const ev = this.pop(); if (ev.dead) continue; this.t = ev.t;
      if (ev.cb) { ev.cb(); continue; }
      this.events++;
      const e = ev.e; e.pend[ev.i] = null; e.drive[ev.i] = ev.val;
      const net = e.outs[ev.i]; this.change(net, this.resolve(net));
    }
    this.t = t;
  }
  at(t, cb) { this.push({ t: Math.max(t, this.t), s: this.seq++, cb, dead: false }); }   // call cb at time t (for a testbench)
  settle(limit = 500) { for (const e of this.els) this.update(e); this.runTo(this.t + limit); }
  venc() { const e = this.els.find(x => x.type === 'venc'); return e ? e.ins.map((n, i) => this.in(e, i)) : null; }
}

if (typeof module !== 'undefined') module.exports = { Ula6cSim, ULA6C_DELAY };
