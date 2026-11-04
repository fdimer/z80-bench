// ---- Z80 assembler (two-pass). Opcode table is generated from the disassembler. ----
const ASM_TABLE = (() => {
  const table = new Map();
  const add = bytes => {
    const rec = [];
    const { text } = disasm(a => (a < bytes.length ? bytes[a] : 0), 0, rec);
    if (text === 'NOP*') return;
    const key = text.toUpperCase();
    const prev = table.get(key);
    if (!prev || rec.length < prev.length) table.set(key, rec);
  };
  for (let op = 0; op < 256; op++) if (![0xCB, 0xED, 0xDD, 0xFD].includes(op)) add([op]);
  for (let op = 0; op < 256; op++) { add([0xCB, op]); add([0xED, op]); }
  for (const px of [0xDD, 0xFD]) {
    for (let op = 0; op < 256; op++) if (![0xCB, 0xED, 0xDD, 0xFD].includes(op)) add([px, op]);
    for (let op = 0; op < 256; op++) add([px, 0xCB, 0, op]);
  }
  return table;
})();

const ASM_FIXED = new Set(['A', 'B', 'C', 'D', 'E', 'H', 'L', 'I', 'R', 'AF', "AF'", 'BC', 'DE', 'HL', 'SP', 'IX', 'IY',
  'IXH', 'IXL', 'IYH', 'IYL', '(C)', '(HL)', '(BC)', '(DE)', '(SP)', '(IX)', '(IY)', 'NZ', 'Z', 'NC', 'PO', 'PE', 'P', 'M']);
const ASM_RESERVED = new Set([...ASM_FIXED].filter(s => /^[A-Z']+$/.test(s)));

class AsmError extends Error {}

function asmSplit(s, sep) { // split on sep at top level (outside quotes/parens)
  const out = []; let depth = 0, q = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if ((ch === '"' || ch === "'") && !(ch === "'" && /AF$/i.test(cur.trim()))) { q = ch; cur += ch; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim());
}
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"') q = ch;
    else if (ch === "'" && !/AF$/i.test(s.slice(0, i).trim())) q = ch;
    else if (ch === ';') return s.slice(0, i);
  }
  return s;
}

// expression evaluator: numbers (1Fh 0x1F $1F %1010 1010b 42 'A'), $ = current address, labels, + - * / % & | ^ << >> ~ ( )
function asmEval(expr, syms, pc, strict) {
  const src = expr.trim();
  let i = 0, unknown = false;
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const fail = m => { throw new AsmError(m); };
  function primary() {
    ws();
    const ch = src[i];
    if (ch === '(') { i++; const v = bor(); ws(); if (src[i] !== ')') fail('missing )'); i++; return v; }
    if (ch === '-') { i++; return -primary(); }
    if (ch === '+') { i++; return primary(); }
    if (ch === '~') { i++; return ~primary(); }
    if (ch === "'" || ch === '"') { const end = src.indexOf(ch, i + 1); if (end !== i + 2) fail('character constants must be one character, like \'A\''); const v = src.charCodeAt(i + 1); i = end + 1; return v; }
    let m;
    const rest = src.slice(i);
    if ((m = rest.match(/^0x([0-9a-f]+)/i))) { i += m[0].length; return parseInt(m[1], 16); }
    if ((m = rest.match(/^\$([0-9a-f]+)/i))) { i += m[0].length; return parseInt(m[1], 16); }
    if ((m = rest.match(/^\$/))) { i += 1; return pc; }
    if ((m = rest.match(/^%([01]+)/))) { i += m[0].length; return parseInt(m[1], 2); }
    if ((m = rest.match(/^([0-9][0-9a-f]*)h\b/i))) { i += m[0].length; return parseInt(m[1], 16); }
    if ((m = rest.match(/^([01]+)b\b/i))) { i += m[0].length; return parseInt(m[1], 2); }
    if ((m = rest.match(/^[0-9]+\b/))) { i += m[0].length; return parseInt(m[0], 10); }
    if ((m = rest.match(/^[A-Za-z_.][A-Za-z0-9_.]*/))) {
      i += m[0].length;
      const k = m[0].toUpperCase();
      if (syms.has(k)) return syms.get(k);
      if (strict) fail(`unknown label "${m[0]}"`);
      unknown = true; return 0;
    }
    fail(`can't read "${rest || expr}"`);
  }
  function mul() { let v = primary(); for (;;) { ws(); const c = src[i]; if (c === '*') { i++; v *= primary(); } else if (c === '/') { i++; const d = primary(); if (!d) { if (strict) fail('division by zero'); v = 0; } else v = Math.trunc(v / d); } else if (c === '%') { i++; const d = primary(); v = d ? v % d : 0; } else return v; } }
  function add() { let v = mul(); for (;;) { ws(); const c = src[i]; if (c === '+') { i++; v += mul(); } else if (c === '-') { i++; v -= mul(); } else return v; } }
  function shift() { let v = add(); for (;;) { ws(); if (src.startsWith('<<', i)) { i += 2; v <<= add(); } else if (src.startsWith('>>', i)) { i += 2; v >>= add(); } else return v; } }
  function band() { let v = shift(); for (;;) { ws(); if (src[i] === '&') { i++; v &= shift(); } else return v; } }
  function bxor() { let v = band(); for (;;) { ws(); if (src[i] === '^') { i++; v ^= band(); } else return v; } }
  function bor() { let v = bxor(); for (;;) { ws(); if (src[i] === '|') { i++; v |= bxor(); } else return v; } }
  if (!src) fail('missing value');
  const v = bor(); ws();
  if (i < src.length) fail(`unexpected "${src.slice(i)}"`);
  return { v, unknown };
}

function wrapsWhole(s) { // "(...)" where the outer parens match each other
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let d = 0;
  for (let i = 0; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (d === 0 && i < s.length - 1) return false; } }
  return true;
}

function asmOperandChoices(mn, idx, raw, ev) {
  const up = raw.toUpperCase().replace(/\s+/g, '');
  if (up === 'AF' && mn === 'EX' && idx === 1) return [{ t: "AF'" }];
  if (mn === 'JP' && (up === 'HL' || up === 'IX' || up === 'IY')) return [{ t: '(' + up + ')' }];
  if (mn === 'OUT' && idx === 1 && up === '0') return [{ t: '0' }, { t: '{N}', n: raw }];
  if (ASM_FIXED.has(up)) {
    const c = [{ t: up }];
    if (up === '(IX)' || up === '(IY)') c.push({ t: '(' + up.slice(1, 3) + '+{D})', d: '0' });
    return c;
  }
  let m;
  if ((m = raw.trim().match(/^\(\s*(I[XY])\s*([+-][\s\S]*)\)$/i))) return [{ t: '(' + m[1].toUpperCase() + '+{D})', d: m[2] }];
  if ((mn === 'BIT' || mn === 'SET' || mn === 'RES') && idx === 0) return [{ t: String(ev(raw, true) & 0xFF) }];
  if (mn === 'IM') return [{ t: String(ev(raw, true)) }];
  if (mn === 'RST') return [{ t: h2(ev(raw, true) & 0xFF) + 'H' }];
  if (wrapsWhole(raw.trim())) { const inner = raw.trim().slice(1, -1); return [{ t: '({NN})', nn: inner }, { t: '({N})', n: inner }]; }
  return [{ t: '{N}', n: raw }, { t: '{NN}', nn: raw }, { t: '{E}', e: raw }];
}

function asmFindPattern(mn, ops, ev) {
  // accept common alternative spellings
  if (['ADD', 'ADC', 'SBC'].includes(mn) && ops.length === 1) ops = ['A', ops[0]];
  if (['SUB', 'AND', 'XOR', 'OR', 'CP'].includes(mn) && ops.length === 2 && ops[0].trim().toUpperCase() === 'A') ops = [ops[1]];
  const choices = ops.map((o, i) => asmOperandChoices(mn, i, o, ev));
  const combos = [[]];
  for (const ch of choices) { const next = []; for (const c of combos) for (const x of ch) next.push([...c, x]); combos.splice(0, combos.length, ...next); }
  for (const combo of combos) {
    const key = mn + (combo.length ? ' ' + combo.map(c => c.t).join(',') : '');
    const tpl = ASM_TABLE.get(key);
    if (tpl) { const vals = {}; for (const c of combo) for (const k of ['n', 'nn', 'd', 'e']) if (c[k] !== undefined) vals[k] = c[k]; return { tpl, vals }; }
  }
  return null;
}

function parseString(s) { // "text" -> bytes, or null
  const t = s.trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return [...t.slice(1, -1)].map(c => c.charCodeAt(0) & 0xFF);
  if (t.length > 3 && t[0] === "'" && t[t.length - 1] === "'") return [...t.slice(1, -1)].map(c => c.charCodeAt(0) & 0xFF);
  return null;
}

// base: address used for code before the first ORG (default 0000h)
function assemble(source, base = 0) {
  const lines = source.split(/\r?\n/);
  const syms = new Map();
  let result, pass1Errors = [];
  for (let pass = 1; pass <= 2; pass++) {
    const strict = pass === 2;
    const errors = [], chunks = [], listing = [];
    let pc = base & 0xFFFF, cur = null;
    const emit = (bytes, ln, text) => {
      if (!cur || cur.addr + cur.bytes.length !== pc) { cur = { addr: pc, bytes: [] }; chunks.push(cur); }
      listing.push({ addr: pc, bytes: bytes.slice(), line: ln, text });
      for (const b of bytes) { cur.bytes.push(b & 0xFF); pc = (pc + 1) & 0xFFFF; }
    };
    for (let ln = 0; ln < lines.length; ln++) {
      const original = lines[ln];
      try {
        let s = stripComment(original).replace(/\s+$/, '');
        if (!s.trim()) continue;
        let label = null, m;
        if ((m = s.match(/^\s*([A-Za-z_.][A-Za-z0-9_.]*)\s*:/))) { label = m[1]; s = s.slice(m[0].length); }
        else if ((m = s.match(/^([A-Za-z_.][A-Za-z0-9_.]*)\s+(EQU|DEFL|=)\b/i)) || (m = s.match(/^([A-Za-z_.][A-Za-z0-9_.]*)\s*=/))) { label = m[1]; s = s.slice(m[1].length); }
        s = s.trim();
        let mn = '', rest = '';
        if ((m = s.match(/^(=|[A-Za-z.]+)\s*([\s\S]*)$/))) { mn = m[1].toUpperCase().replace(/^\./, ''); rest = m[2].trim(); }
        else if (s) throw new AsmError(`can't read "${s}"`);
        const ev = (e, must) => { const r = asmEval(e, syms, pc, strict || must); return r.v; };
        if (label) {
          const L = label.toUpperCase();
          if (ASM_RESERVED.has(L)) throw new AsmError(`"${label}" is a register name and can't be a label`);
          if (mn === 'EQU' || mn === '=' || mn === 'DEFL') {
            const v = ev(rest);
            if (pass === 1 && syms.has(L) && mn === 'EQU' && syms.get(L) !== v) throw new AsmError(`"${label}" is defined twice`);
            syms.set(L, v & 0xFFFF);
            listing.push({ addr: null, bytes: [], line: ln, text: original.trim() });
            continue;
          }
          if (pass === 1 && syms.has(L)) throw new AsmError(`label "${label}" is defined twice`);
          syms.set(L, pc);
        }
        if (!mn) continue;
        switch (mn) {
          case 'ORG': pc = ev(rest, true) & 0xFFFF; cur = null; continue;
          case 'END': ln = lines.length; continue;
          case 'DB': case 'DEFB': case 'DEFM': case 'BYTE': {
            const bytes = [];
            for (const item of asmSplit(rest, ',')) {
              const str = parseString(item);
              if (str) bytes.push(...str);
              else { const v = ev(item); if (strict && (v < -128 || v > 255)) throw new AsmError(`${item} doesn't fit in a byte`); bytes.push(v & 0xFF); }
            }
            emit(bytes, ln, original.trim()); continue;
          }
          case 'DW': case 'DEFW': case 'WORD': {
            const bytes = [];
            for (const item of asmSplit(rest, ',')) { const v = ev(item) & 0xFFFF; bytes.push(v & 0xFF, v >> 8); }
            emit(bytes, ln, original.trim()); continue;
          }
          case 'DS': case 'DEFS': case 'BLOCK': {
            const [n, fill] = asmSplit(rest, ',');
            const count = ev(n, true);
            if (count < 0 || count > 65536) throw new AsmError('DS size must be 0–65536');
            emit(new Array(count).fill(fill ? ev(fill) & 0xFF : 0), ln, original.trim()); continue;
          }
        }
        const ops = rest ? asmSplit(rest, ',') : [];
        const found = asmFindPattern(mn, ops, ev);
        if (!found) throw new AsmError(`not a Z80 instruction: ${mn}${rest ? ' ' + rest : ''}`);
        const { tpl, vals } = found;
        const bytes = [];
        const nn = vals.nn !== undefined ? ev(vals.nn) : 0;
        for (const k of tpl) {
          if (typeof k === 'number') bytes.push(k);
          else if (k === 'n') { const v = ev(vals.n); if (strict && (v < -128 || v > 255)) throw new AsmError(`${vals.n.trim()}${String(v) === vals.n.trim() ? '' : ' (= ' + v + ')'} doesn't fit in a byte (−128…255)`); bytes.push(v & 0xFF); }
          else if (k === 'nl') bytes.push(nn & 0xFF);
          else if (k === 'nh') bytes.push((nn >> 8) & 0xFF);
          else if (k === 'd') { const v = ev(vals.d.replace(/^\+/, '')); if (strict && (v < -128 || v > 127)) throw new AsmError(`index offset ${v} is outside −128…127`); bytes.push(v & 0xFF); }
          else if (k === 'e') {
            const target = ev(vals.e);
            const off = target - ((pc + tpl.length) & 0xFFFF);
            if (strict && (off < -128 || off > 127)) throw new AsmError(`jump target is ${off} bytes away; relative jumps reach −128…127 (use JP)`);
            bytes.push(off & 0xFF);
          }
        }
        emit(bytes, ln, original.trim());
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        errors.push({ line: ln + 1, msg: e.message });
      }
    }
    if (pass === 1) { pass1Errors = errors.filter(e => /twice|register name/.test(e.msg)); continue; }
    const seen = new Set(pass1Errors.map(e => e.line));
    const all = pass1Errors.concat(errors.filter(e => !seen.has(e.line))).sort((x, y) => x.line - y.line);
    result = { chunks, errors: all, listing, syms };
  }
  return result;
}

if (typeof module !== 'undefined') module.exports = { assemble, ASM_TABLE };
