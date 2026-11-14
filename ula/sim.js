// ---- ZX81 ULA: event-driven gate-level simulation of a netlist in ula/*.net ----
// Every gate, flip-flop and pin buffer of the netlist becomes one element with a delay. A change on a net
// re-evaluates the elements it feeds, and their new outputs are scheduled after their delay (inertial: a pulse
// shorter than the delay is swallowed, as in a real gate). Time is in nanoseconds.
//
// Conventions (see ula/README.md):
//   an input written ~net is inverted; dff and tff act on the rising edge of their clock input as written
//   (so ~SCLK = the falling edge of SCLK); reset inputs are active high and asynchronous; '-' = not connected;
//   a dlatch is transparent while its enable input (as written) is high; an output named NQ... is the inverted output;
//   pin_oc pulls its pin low while its input is low; pin_ts drives its pin with its input while the enable is high;
//   pin_tp is a push-pull output, pin_tpn an inverting one (the memory selects need it: ROMCSi is high for a ROM access).
// Pins are nets too. The outside world sets pin_in/pin_io/osc nets with set(); a pin_io net reads low when the
// outside drives it low or any of the chip's open-collector drivers pulls it (wired AND); a pin_ts net reads
// what the chip drives while enabled, and what the outside drives (through the board's resistor) otherwise.

const ULA_DELAY = { buf_ef: 3, inv: 6, nor: 7, or: 9, rtl: 25, dff: 10, tff: 10, dlatch: 8, pin: 8, out3: 8 };
// Ferranti, ULA2C000/5C000 data, Table 2.1: gate delay in ns (typical, 25 C) by power (R single, R/2 double, R/3 treble
// current source), fan-in 1-8 (rows) and fan-out 1-6 (columns). Beyond fan-out 6 the last step is carried on.
const ULA_GATE_NS = {
  'R':   [[5.7, 8.4, 11.1, 13.9, 16.6, 19.3], [6.2, 9.0, 11.7, 14.5, 17.2, 19.9], [9.8, 12.5, 15.2, 18.0, 20.7, 23.4], [10.4, 13.1, 15.8, 18.6, 21.3, 24.0],
          [13.8, 16.6, 19.3, 22.0, 24.8, 27.5], [14.4, 17.2, 19.9, 22.7, 25.4, 28.1], [17.9, 20.7, 23.4, 26.2, 28.9, 31.7], [18.5, 21.3, 24.0, 26.8, 29.5, 32.2]],
  'R/2': [[2.8, 4.2, 5.6, 6.9, 8.3, 9.7], [3.1, 4.5, 5.9, 7.2, 8.6, 10.0], [4.9, 6.2, 7.6, 9.0, 10.4, 11.7], [5.2, 6.5, 7.9, 9.3, 10.7, 12.0],
          [6.9, 8.3, 9.7, 11.0, 12.4, 13.8], [7.2, 8.6, 10.0, 11.3, 12.7, 14.1], [9.0, 10.4, 11.7, 13.1, 14.5, 15.8], [9.3, 10.7, 12.0, 13.4, 14.8, 16.1]],
  'R/3': [[1.9, 2.8, 3.7, 4.6, 5.5, 6.4], [2.1, 3.0, 3.9, 4.8, 5.7, 6.6], [3.3, 4.2, 5.1, 6.0, 6.9, 7.8], [3.5, 4.4, 5.3, 6.2, 7.1, 8.0],
          [4.6, 5.5, 6.4, 7.4, 8.3, 9.2], [4.8, 5.7, 6.6, 7.6, 8.5, 9.4], [6.0, 6.9, 7.8, 8.7, 9.6, 10.6], [6.2, 7.1, 8.0, 8.9, 9.8, 10.7]]
};
function ulaGateNs(pwr, fanIn, fanOut) {
  const row = ULA_GATE_NS[pwr][Math.min(Math.max(fanIn, 1), 8) - 1], fo = Math.max(fanOut, 1);
  return fo <= 6 ? row[fo - 1] : row[5] + (fo - 6) * (row[5] - row[4]);
}

class UlaSim {
  constructor(text, opts = {}) {
    this.delay = Object.assign({}, ULA_DELAY, opts.delay || {});
    this.v = Object.create(null);           // net -> 0/1
    this.fan = Object.create(null);         // net -> elements reading it
    this.els = []; this.alias = {}; this.pins = {}; this.ext = Object.create(null); this.wired = Object.create(null);
    this.t = 0; this.q = []; this.seq = 0; this.watch = Object.create(null); this.events = 0;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
      const f = line.split(/\s+/), at = f.findIndex(x => x[0] === '@'), w = at < 0 ? f : f.slice(0, at);
      const [id, type] = w; const tail = at < 0 ? '' : f.slice(at).join(' ');
      if (id === 'alias') { this.alias[type] = w[2]; continue; }
      const dm = /delay=([\d.]+)/.exec(tail), pm = /\bpwr=(R\/2|R\/3|R)\b/.exec(tail);
      let outs, ins;
      if (type === 'tff') { outs = w.slice(2, 4); ins = w.slice(4); } else { outs = [w[2]]; ins = w.slice(3); }
      this.els.push({ id, type, outs, ins, d: dm ? +dm[1] : null, pwr: pm ? pm[1] : null, grid: at < 0 ? '' : f[at].slice(1) });
    }
    const R = n => this.alias[n] || n;
    for (const e of this.els) {
      e.outs = e.outs.map(R);
      e.inv = e.ins.map(n => n[0] === '~'); e.ins = e.ins.map(n => R(n.replace(/^~/, '')));
      if (e.d === null && e.pwr && !opts.flatDelays) e.pwrPending = true;     // from Ferranti's table, once the fan-outs are known
      if (e.d === null) e.d = this.delay[/^nor/.test(e.type) ? (e.type.endsWith('_rtl') ? 'rtl' : 'nor') : /^or/.test(e.type) ? 'or'
        : e.type === 'inv_rtl' ? 'rtl' : /^pin_(oc|ts|tp)/.test(e.type) ? 'pin' : e.type] || this.delay.inv;
      e.state = 0; e.pend = null;
      if (e.type === 'pin_in' || e.type === 'pin_io' || e.type === 'osc') { this.pins[e.outs[0]] = e.ins[0]; this.ext[e.outs[0]] = 1; e.src = true; }
      if (e.type === 'pin_oc' || e.type === 'pin_ts') (this.wired[e.outs[0]] = this.wired[e.outs[0]] || []).push(e);
      for (const n of e.ins) if (n !== '-' && n !== 'VCC' && n !== 'GND') (this.fan[n] = this.fan[n] || []).push(e);
    }
    // gate delays from Ferranti's table: fan-in is the gate's inputs, fan-out the inputs its output drives. A flip-flop
    // or latch cell is taken as two gates of its power: one loaded inside the cell, then one driving its outputs.
    const loads = n => (n === '-' ? 0 : (this.fan[n] || []).length);
    for (const e of this.els) if (e.pwrPending) {
      const out = Math.max(1, ...e.outs.map(loads));
      e.d = +(/^(dff|tff|dlatch)$/.test(e.type) ? ulaGateNs(e.pwr, 2, 2) + ulaGateNs(e.pwr, 2, out + 1) : ulaGateNs(e.pwr, e.ins.length, out)).toFixed(1);
      delete e.pwrPending;
    }
    // a pin_ts net is also read by the chip (A0', A1'): what is outside counts while the chip lets go
    for (const n in this.wired) if (!(n in this.ext)) this.ext[n] = 1;
    this.drv = Object.create(null);          // element output value per wired driver: e.id -> 0/1/null
    this.v.VCC = 1; this.v.GND = 0;
    for (const e of this.els) for (const n of e.outs) if (n !== '-' && !(n in this.v)) this.v[n] = 0;
    for (const n in this.ext) this.v[n] = this.resolve(n);
    for (const [n, val] of Object.entries(opts.init || {})) this.v[n] = val;
    this.settle();
  }
  get(n) { n = this.alias[n] || n; return this.v[n]; }
  in(e, i) { const n = e.ins[i]; if (n === '-') return 0; const x = n === 'VCC' ? 1 : n === 'GND' ? 0 : this.v[n] | 0; return e.inv[i] ? 1 - x : x; }
  // the value an element wants on its outputs now (flip-flops are handled in update())
  calc(e) {
    const t = e.type, n = e.ins.length;
    if (t === 'buf_ef') return this.in(e, 0);
    if (t === 'inv' || t === 'inv_rtl' || t === 'pin_tpn') return 1 - this.in(e, 0);
    if (t === 'pin_tp') return this.in(e, 0);
    if (/^nor/.test(t)) { for (let i = 0; i < n; i++) if (this.in(e, i)) return 0; return 1; }
    if (/^or/.test(t)) { for (let i = 0; i < n; i++) if (this.in(e, i)) return 1; return 0; }
    if (t === 'pin_oc') return this.in(e, 0) ? null : 0;
    if (t === 'pin_ts') return this.in(e, 1) ? this.in(e, 0) : null;
    if (t === 'out3') return this.in(e, 0) ? 0 : this.in(e, 1) ? 1 : 2;       // 0 sync (N.SYNC high: it is SYNCn inverted), 1 black (N.VIDEO high), 2 white
    return null;
  }
  resolve(n) {                              // the level on a pin net
    let x = n in this.ext ? this.ext[n] : 1, chip = null;
    for (const e of this.wired[n] || []) { const d = this.drv[e.id]; if (d === null || d === undefined) continue; if (e.type === 'pin_ts') chip = chip === null ? d : chip & d; else x &= d; }
    return chip !== null ? chip : x;
  }
  schedule(e, outI, val) {
    const net = e.outs[outI]; if (net === '-') return;
    const key = outI;
    e.pend = e.pend || [];
    const p = e.pend[key];
    const cur = this.wired[net] ? this.drv[e.id] : this.v[net];
    if (p && p.val === val) return;                         // already on its way
    if (p) p.dead = true;                                    // inertial: the newer value wins
    e.pend[key] = null;
    if (val === cur) return;                                 // back to the present value: the pulse is swallowed
    const ev = { t: this.t + e.d, s: this.seq++, e, outI, val, dead: false }; e.pend[key] = ev; this.push(ev);
  }
  update(e) {
    const t = e.type;
    if (e.src) return;
    if (t === 'dff' || t === 'tff' || t === 'dlatch') {
      const clk = this.in(e, t === 'tff' ? 0 : 1), rst = this.in(e, t === 'tff' ? 1 : t === 'dff' ? 2 : 99);
      const rose = clk && !e.lastClk; e.lastClk = clk;
      if (t === 'dlatch') { if (clk) e.state = this.in(e, 0); }
      else if (rst) e.state = 0;
      else if (rose) e.state = t === 'tff' ? 1 - e.state : this.in(e, 0);
      e.outs.forEach((o, i) => { const inv = t === 'tff' ? i === 1 : /^NQ/.test(o); this.schedule(e, i, inv ? 1 - e.state : e.state); });
      return;
    }
    this.schedule(e, 0, this.calc(e));
  }
  set(n, val) {                             // the outside drives pin net n
    n = this.alias[n] || n; if (this.ext[n] === val) return; this.ext[n] = val; this.change(n, this.resolve(n));
  }
  change(n, val) {
    if (this.v[n] === val) return; this.v[n] = val;
    const w = this.watch[n]; if (w) w(val, this.t);
    for (const e of this.fan[n] || []) this.update(e);
  }
  push(ev) { const q = this.q; q.push(ev); let i = q.length - 1; while (i) { const p = (i - 1) >> 1; if (this.lt(q[p], ev)) break; q[i] = q[p]; i = p; } q[i] = ev; }
  lt(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s); }
  pop() { const q = this.q, top = q[0], last = q.pop(); if (q.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= q.length) break; if (c + 1 < q.length && this.lt(q[c + 1], q[c])) c++; if (this.lt(last, q[c])) break; q[i] = q[c]; i = c; } q[i] = last; } return top; }
  // run until time t (ns); fire events in order
  runTo(t) {
    while (this.q.length && this.q[0].t <= t) {
      const ev = this.pop(); if (ev.dead) continue; this.t = ev.t; this.events++;
      const e = ev.e; e.pend[ev.outI] = null; const net = e.outs[ev.outI];
      if (this.wired[net]) { this.drv[e.id] = ev.val; this.change(net, this.resolve(net)); }
      else this.change(net, ev.val);
    }
    this.t = t;
  }
  settle(limit = 2000) { for (const e of this.els) this.update(e); this.runTo(this.t + limit); }
}

if (typeof module !== 'undefined') module.exports = { UlaSim, ULA_DELAY, ULA_GATE_NS, ulaGateNs };
