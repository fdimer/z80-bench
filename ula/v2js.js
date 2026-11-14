// ---- ZX81 ULA: run the synchronous Verilog (ula/2c210_sync.v) without a Verilog simulator ----
// translate(text, 'ula2c210_core') turns one module, written in a small subset of Verilog, into JavaScript:
//   ports and declarations:  input/output wire [n:0] name,   reg [n:0] name = <literal>;   wire [n:0] name = <expr>;
//   assign name = <expr>;
//   always @(posedge clk) <statement>      statement: begin ... end | if (..) st [else st] | name <= <expr>;
//   expressions: names, name[i], name[m:l], literals (12, 2'd1, 8'hBF, 1'b0), ( ), ! ~ & | ^ && || == != + - << >> ?:
// No concatenations, no reductions, no comparisons with < or >, nothing wider than 32 bits. Every assignment is cut
// to the width of what it assigns to, as Verilog does; inside an expression nothing is cut, so the design keeps ~
// on a vector to places where the result is masked or cut straight away.
// It is a check that the Verilog text itself behaves, not a replacement for a real simulator or a synthesis run.
// SyncUla wraps the translated core with the same interface as UlaSim (set, get, watch, runTo), using the testbench's
// names for the pins, so ula/tb.js can drive either. Each change of OSC is one rising edge of the 13 MHz clock.

function tokens(src) {
  const out = [], re = /\s+|\/\/[^\n]*|(\d+)?'([bdh])([0-9a-fA-F_]+)|(\d+)|([A-Za-z_]\w*)|(<=|==|!=|&&|\|\||<<|>>|[()\[\]:;,?!~&|^+\-=@.#<>])/y;
  let m; re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    m = re.exec(src); if (!m) throw new Error('cannot read Verilog at: ' + src.slice(re.lastIndex, re.lastIndex + 40));
    if (m[2]) out.push({ k: 'num', v: parseInt(m[3].replace(/_/g, ''), { b: 2, d: 10, h: 16 }[m[2]]) });
    else if (m[4]) out.push({ k: 'num', v: +m[4] });
    else if (m[5]) out.push({ k: 'id', v: m[5] });
    else if (m[6]) out.push({ k: 'op', v: m[6] });
  }
  return out;
}

function translate(text, modName) {
  const a = text.indexOf('module ' + modName), b = text.indexOf('endmodule', a); if (a < 0) throw new Error('no module ' + modName);
  const T = tokens(text.slice(a, b)); let p = 0;
  const peek = () => T[p] || { k: 'eof' }, is = v => peek().v === v && peek().k !== 'num', eat = v => { if (!is(v)) throw new Error(`expected ${v}, found ${JSON.stringify(peek())}`); p++; };
  const width = {}, kind = {}, init = {}, assigns = [], always = [];
  const range = () => { if (!is('[')) return 1; eat('['); const hi = T[p++].v; eat(':'); const lo = T[p++].v; eat(']'); if (lo !== 0) throw new Error('ranges must end at 0'); return hi + 1; };
  // an expression, as JavaScript text over the state object s; stops at one of the given tokens at depth 0
  const expr = stop => {
    let js = '', depth = 0;
    for (;;) {
      const t = peek(); if (t.k === 'eof') throw new Error('unfinished expression');
      if (depth === 0 && t.k === 'op' && stop.includes(t.v)) return js;
      p++;
      if (t.k === 'num') js += t.v;
      else if (t.k === 'id') {
        if (!(t.v in width)) throw new Error('unknown name ' + t.v);
        if (is('[')) { eat('['); const hi = T[p++].v; let lo = hi; if (is(':')) { eat(':'); lo = T[p++].v; } eat(']'); js += `((s.${t.v} >>> ${lo}) & ${2 ** (hi - lo + 1) - 1})`; }
        else js += 's.' + t.v;
      } else {
        if (t.v === '(') depth++; if (t.v === ')') depth--;
        if (['<', '>', '=', '<=', '[', ']', '@', '.', '#', ','].includes(t.v)) throw new Error('not in the subset: ' + t.v);
        js += ' ' + (t.v === '==' ? '===' : t.v === '!=' ? '!==' : t.v) + ' ';
      }
    }
  };
  const mask = n => 2 ** width[n] - 1;
  const stmt = () => {
    if (is('begin')) { eat('begin'); let js = ''; while (!is('end')) js += stmt(); eat('end'); return js; }
    if (is('if')) { eat('if'); eat('('); const c = expr([')']); eat(')'); let js = `if (${c}) {${stmt()}}`; if (is('else')) { eat('else'); js += ` else {${stmt()}}`; } return js; }
    const n = T[p++].v; if (kind[n] !== 'reg') throw new Error('assignment to ' + n + ', which is not a reg'); eat('<=');
    const e = expr([';']); eat(';'); return `n.${n} = (${e}) & ${mask(n)};`;
  };
  eat('module'); p++; eat('(');
  while (!is(')')) { const dir = T[p++].v; if (is('wire')) eat('wire'); const w = range(), n = T[p++].v; width[n] = w; kind[n] = dir; if (is(',')) eat(','); }
  eat(')'); eat(';');
  while (p < T.length) {
    if (is('reg') || is('wire')) {
      const k = T[p++].v, w = range(), n = T[p++].v; width[n] = w; kind[n] = k;
      if (is('=')) { eat('='); if (k === 'reg') init[n] = T[p++].v; else assigns.push([n, expr([';'])]); }
      eat(';');
    } else if (is('assign')) { eat('assign'); const n = T[p++].v; eat('='); assigns.push([n, expr([';'])]); eat(';'); }
    else if (is('always')) { eat('always'); eat('@'); eat('('); eat('posedge'); eat('clk'); eat(')'); always.push(stmt()); }
    else throw new Error('not in the subset: ' + JSON.stringify(peek()));
  }
  const regs = Object.keys(kind).filter(n => kind[n] === 'reg');
  return {
    width, kind, regs, init,
    inputs: Object.keys(kind).filter(n => kind[n] === 'input'), outputs: Object.keys(kind).filter(n => kind[n] === 'output'),
    // settle the wires from the inputs and regs (repeated until nothing moves: the order of the assigns does not matter)
    comb: new Function('s', `for (let i = 0; i < 20; i++) { let ch = false, v;\n${assigns.map(([n, e]) => `v = (${e}) & ${mask(n)}; if (v !== s.${n}) { s.${n} = v; ch = true; }`).join('\n')}\nif (!ch) return; } throw new Error('combinational loop');`),
    // one rising edge of clk: every reg's next value from the present values, then all at once (non-blocking)
    edge: new Function('s', `const n = {};\n${always.join('\n')}\nfor (const k in n) s[k] = n[k];`)
  };
}

// The same core after a real compiler has read it: Yosys synthesizes ula2c210_core to plain gates and flip-flops,
//   yosys -p "read_verilog 2c210_sync.v; synth -top ula2c210_core -flatten -noabc; opt_clean;
//             dfflegalize -cell $_DFF_P_ 01; opt_clean; write_json core.json"
// and fromYosys() runs that netlist. Same shape as translate()'s result, so SyncUla can use either.
function fromYosys(json, modName) {
  const m = json.modules[modName], cells = Object.values(m.cells), bit = [], width = {}, kind = {}, init = {};
  const val = b => b === '0' ? 0 : b === '1' ? 1 : b === 'x' || b === 'z' ? 0 : bit[b] | 0;
  for (const [n, pt] of Object.entries(m.ports)) { width[n] = pt.bits.length; kind[n] = pt.direction; }
  const named = Object.entries(m.netnames).filter(([n, v]) => !v.hide_name && !(n in m.ports) && /^\w+$/.test(n));
  for (const [n, v] of named) { width[n] = v.bits.length; kind[n] = 'wire'; }
  const ffs = cells.filter(c => c.type === '$_DFF_P_'), gates = cells.filter(c => c.type !== '$_DFF_P_');
  for (const c of gates) if (!['$_AND_', '$_OR_', '$_XOR_', '$_NOT_', '$_MUX_'].includes(c.type)) throw new Error('cell ' + c.type);
  for (const v of Object.values(m.netnames)) if (v.attributes && v.attributes.init) [...v.attributes.init].reverse().forEach((ch, i) => { bit[v.bits[i]] = ch === '1' ? 1 : 0; });
  const comb = s => {
    for (const [n, pt] of Object.entries(m.ports)) if (pt.direction === 'input') pt.bits.forEach((b, i) => { bit[b] = s[n] >> i & 1; });
    for (let pass = 0; ; pass++) {
      if (pass > 60) throw new Error('combinational loop'); let ch = false;
      for (const c of gates) {
        const k = c.connections, A = val(k.A[0]), B = k.B ? val(k.B[0]) : 0;
        const y = c.type === '$_AND_' ? A & B : c.type === '$_OR_' ? A | B : c.type === '$_XOR_' ? A ^ B : c.type === '$_NOT_' ? 1 - A : val(k.S[0]) ? B : A;
        if ((bit[k.Y[0]] | 0) !== y || bit[k.Y[0]] === undefined) { bit[k.Y[0]] = y; ch = true; }
      }
      if (!ch) break;
    }
    for (const [n, pt] of Object.entries(m.ports)) if (pt.direction === 'output') s[n] = pt.bits.reduce((a, b, i) => a | val(b) << i, 0);
    for (const [n, v] of named) s[n] = v.bits.reduce((a, b, i) => a | val(b) << i, 0);
  };
  const edge = s => { comb(s); const d = ffs.map(c => val(c.connections.D[0])); ffs.forEach((c, i) => { bit[c.connections.Q[0]] = d[i]; }); };
  return { width, kind, regs: [], init, comb, edge, cells: gates.length, ffs: ffs.length };
}

// the testbench's names for the pins and for the few inside nets it looks at
class SyncUla {
  constructor(text) {      // Verilog text, or a module already made by fromYosys()
    const M = this.M = typeof text === 'string' ? translate(text, 'ula2c210_core') : text, s = this.s = {};
    for (const n in M.width) s[n] = 0;
    for (const n of M.regs) s[n] = M.init[n] || 0;
    this.ext = { d: 0xFF, a: 0x1FF }; this.t = 0; this.events = 0; this.watch = {}; this.last = {};
    Object.assign(s, { kbd_n: 0x1F, usa_uk: 1, tape_in: 1, mreq_n: 1, m1_n: 1, rd_n: 1, wr_n: 1, iorq_n: 1, halt_n: 1, a15: 0, a14: 0 });
    this.settle();
  }
  settle() {
    const s = this.s;
    for (let i = 0; i < 4; i++) {            // the chip reads its own pins: what it pulls low, it reads low
      const d = this.ext.d & ~s.d_pull & 0xFF, a = s.a_oe ? s.a_out : this.ext.a;
      s.d_in = d; s.a0_in = a & 1; s.a1_in = a >> 1 & 1; this.M.comb(s);
      if ((this.ext.d & ~s.d_pull & 0xFF) === d && (s.a_oe ? s.a_out : this.ext.a) === a) break;
    }
    for (const n in this.watch) { const v = this.get(n); if (!(n in this.last)) { this.last[n] = v; continue; } if (v !== this.last[n]) { this.last[n] = v; this.watch[n](v, this.t); } }
  }
  get(n) {
    const s = this.s; let m;
    if ((m = /^nD(\d)$/.exec(n))) return (this.ext.d & ~s.d_pull) >> +m[1] & 1;
    if ((m = /^A(\d)'$/.exec(n))) return (s.a_oe ? s.a_out : this.ext.a) >> +m[1] & 1;
    switch (n) {
      case 'N.PHI': return s.phi_n; case 'N.NMI': return 1 - s.nmi_pull; case 'ROM.N.CS': return s.rom_cs_n; case 'RAM.N.CS': return s.ram_cs_n;
      case 'FRAME-SYNC': return s.fs; case 'SYNCn': return 1 - s.sync; case 'TV/TAPE': return s.sync ? 0 : s.black ? 1 : 2;
      case 'Q29': return s.row & 1; case 'Q30': return s.row >> 1 & 1; case 'NQ31': return 1 - (s.row >> 2 & 1);
      case 'Q19': return 1 - s.phi_n; case 'CHAR': return s.chr; case 'FORCE': return s.nop; case 'Q17': return s.q17; case 'AENa': return s.aena; case 'Q20': return s.q20; case 'Q8': return s.sr >> 7 & 1;
    }
    return n in s ? s[n] : undefined;
  }
  set(n, v) {
    const s = this.s; let m;
    if (n === 'OSC') { this.M.edge(s); this.events++; }
    else if ((m = /^nD(\d)$/.exec(n))) this.ext.d = this.ext.d & ~(1 << +m[1]) | v << +m[1];
    else if ((m = /^A(\d)'$/.exec(n))) this.ext.a = this.ext.a & ~(1 << +m[1]) | v << +m[1];
    else if ((m = /^nKB(\d)$/.exec(n))) s.kbd_n = s.kbd_n & ~(1 << +m[1]) | v << +m[1];
    else { const k = { nMREQ: 'mreq_n', nM1: 'm1_n', nRD: 'rd_n', nWR: 'wr_n', nIORQ: 'iorq_n', nHALT: 'halt_n', nA14: 'a14', nA15: 'a15', nUSA: 'usa_uk', nTAPE: 'tape_in' }[n]; if (!k) throw new Error('no pin ' + n); s[k] = v; }
    this.settle();
  }
  runTo(t) { this.t = t; }
}
if (typeof module !== 'undefined') module.exports = { translate, fromYosys, SyncUla };
