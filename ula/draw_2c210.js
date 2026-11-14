// ---- ZX81 ULA 2C210: a typeset logic diagram drawn from the netlist ----
//   node ula/draw_2c210.js <out-dir>     writes 2c210-logic.svg, 2c210-notes.svg and 2c210-xref-N.svg
//   rsvg-convert -f pdf -o 2c210-logic.pdf <the svgs in order>
// Every element of ula/2c210.net is drawn in the grid square the netlist gives (the square on Ferranti's drawing
// LD6679/ULA2C210/1), so the sheet can be laid over the original. A connection is drawn as a wire when its driver
// stands just to the left in the same row; otherwise the input carries the name of its net, and the cross-reference
// sheets list every net's driver and loads with their grid squares. The drawing is generated: change the netlist,
// not the drawing. Source and terms: see ula/README.md (Ferranti archive, strictly non-commercial).
const fs = require('fs'), path = require('path');
const { execSync } = require('child_process');

const net = fs.readFileSync(path.join(__dirname, '2c210.net'), 'utf8');
const COLS = []; for (const p of ['', 'A', 'B']) for (let i = 0; i < 26; i++) COLS.push(p + String.fromCharCode(65 + i));
COLS.length = 62;                                      // A .. Z, AA .. AZ, BA .. BJ, as on the drawing's edges
const NROWS = 37;
const colIx = c => COLS.indexOf(c);

// ---- parse ----
const els = [], alias = {};
for (const raw of net.split('\n')) {
  const line = raw.replace(/\s+#.*$/, '').trim();
  if (!line || line.startsWith('#')) continue;
  const t = line.split(/\s+/);
  if (t[0] === 'alias') { alias[t[1]] = t[2]; continue; }
  const at = t.findIndex(x => /^@\d+[A-Z]+$/.test(x));
  const m = /^@(\d+)([A-Z]+)$/.exec(t[at]);
  const pwr = (/\bpwr=(\S+)/.exec(line) || [])[1];
  const type = t[1];
  const nOut = type === 'tff' ? 2 : 1;
  const outs = t.slice(2, 2 + nOut);
  const insRaw = /^pin_(in|io)$|^osc$/.test(type) ? [] : t.slice(2 + nOut, at);
  const notes = t.slice(at + 1).join(' ');
  const pn = (/\bPN(\d+)\b/.exec(line) || [])[1];
  els.push({ id: t[0], type, outs, ins: insRaw.map(x => x.replace(/^~/, '')), inv: insRaw.map(x => x.startsWith('~')),
    row: +m[1], col: colIx(m[2]), grid: m[1] + m[2], pwr: pwr && pwr.replace('?', ''), pn, notes, line });
}
const real = n => alias[n] || n;
const drivers = {}, loads = {};
for (const e of els) {
  e.outs.forEach((o, k) => { if (o !== '-') (drivers[o] = drivers[o] || []).push({ e, k }); });
  e.ins.forEach((n, k) => { if (n !== '-' && n !== 'VCC') (loads[real(n)] = loads[real(n)] || []).push({ e, k }); });
}
const pinOfNet = {};
for (const e of els) if (/^pin_(in|io)$|^osc$/.test(e.type) && e.pn) pinOfNet[e.outs[0]] = e.pn;

// ---- sheet geometry (A0 landscape, points) ----
const W = 3370, H = 2384, X0 = 64, X1 = W - 40, Y0 = 70, Y1 = H - 214;
const CW = (X1 - X0) / COLS.length, RH = (Y1 - Y0) / NROWS;
const FONT = "font-family:'DejaVu Sans Condensed','DejaVu Sans',sans-serif";
const INK = '#14213d', MUTE = '#6b7280', ACC = '#9a3412', GRIDC = '#d7dde8';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// place: one cell can hold two elements (lck1 and lk2); spread them vertically
const byCell = {};
for (const e of els) (byCell[e.grid] = byCell[e.grid] || []).push(e);
for (const g of Object.values(byCell)) g.forEach((e, i) => {
  e.cx = X0 + (e.col + 0.5) * CW;
  e.cy = Y0 + (e.row - 0.5) * RH + (i - (g.length - 1) / 2) * RH * 0.5;
});

// ---- symbols: each returns svg and sets e.pin (input points) and e.opin (output points) ----
const P = 9.5;                     // input pitch
const out = [];
const L = (...a) => out.push(a.join(''));
const line = (x1, y1, x2, y2, extra = '') => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${extra}/>`;
const text = (x, y, s, size, anchor = 'start', fill = INK, extra = '') =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="${anchor}" fill="${fill}"${extra}>${esc(s)}</text>`;
const bubble = (x, y) => `<circle cx="${(x + 2.8).toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="#fff"/>`;

function triangle(e, { bub = false, w = 16 } = {}) {
  w *= 1.35; const { cx, cy } = e, x = cx - w / 2, h = 16;
  let s = `<path d="M${x},${cy - h / 2} L${x + w},${cy} L${x},${cy + h / 2} Z" fill="#fff"/>`;
  let ox = x + w;
  if (bub) { s += bubble(ox, cy); ox += 5.6; }
  e.pin = [[x, cy]]; e.opin = [[ox, cy]];
  return s;
}
function orGate(e, n, { bub = true } = {}) {
  const { cx, cy } = e, w = 32, h = Math.max(2, n) * P + 5, x = cx - w / 2, y = cy - h / 2;
  const back = 5;                                          // depth of the curved back
  let s = `<path d="M${x},${y} Q${x + w * 0.55},${y} ${x + w},${cy} Q${x + w * 0.55},${y + h} ${x},${y + h} Q${x + back},${cy} ${x},${y} Z" fill="#fff"/>`;
  let ox = x + w; if (bub) { s += bubble(ox, cy); ox += 5.6; }
  e.pin = []; for (let i = 0; i < n; i++) { const py = cy + (i - (n - 1) / 2) * P; e.pin.push([x + back * (1 - Math.pow(2 * (py - cy) / h, 2)), py]); }
  e.opin = [[ox, cy]];
  return s;
}
function box(e, ins, outs, label) {                       // ins/outs: [{name, edge, inv}]
  const { cx, cy } = e, w = 40, n = Math.max(ins.length, outs.length, 2), h = n * 12 + 8, x = cx - w / 2, y = cy - h / 2;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>`;
  e.pin = []; e.opin = [];
  ins.forEach((p, i) => {
    const py = y + 10 + i * 12;
    let px = x;
    if (p.edge) s += `<path d="M${x},${py - 3.2} L${x + 4.5},${py} L${x},${py + 3.2}" fill="none" stroke-width="0.5"/>`;
    if (p.inv) { s += `<circle cx="${x - 2.8}" cy="${py}" r="2.8" fill="#fff"/>`; px = x - 5.6; }
    s += text(x + (p.edge ? 6 : 2.5), py + 2.5, p.name, 7, 'start', INK, ' stroke="none"');
    e.pin.push([px, py]);
  });
  outs.forEach((p, i) => {
    const py = y + 10 + i * 12;
    s += text(x + w - 2.5, py + 2.5, p.name, 7, 'end', INK, ' stroke="none"');
    if (p.bar) s += line(x + w - 2 - 4.6, py - 3.6, x + w - 2, py - 3.6, ' stroke-width="0.4"');
    e.opin.push([x + w, py]);
  });
  if (label) s += text(cx, y - 2.5, label, 6, 'middle', MUTE, ' stroke="none"');
  return s;
}
function pinFlag(x, y, pn, dir) {                         // dir 'in' (points right, at the left edge) or 'out'
  const w = 34, h = 13;
  const d = dir === 'io' ? `M${x},${y} L${x + 4},${y - h / 2} L${x + w - 4},${y - h / 2} L${x + w},${y} L${x + w - 4},${y + h / 2} L${x + 4},${y + h / 2} Z`
    : `M${x},${y - h / 2} L${x + w - 5},${y - h / 2} L${x + w},${y} L${x + w - 5},${y + h / 2} L${x},${y + h / 2} Z`;
  return `<path d="${d}" fill="#fff"/>` + text(x + (w - 3) / 2, y + 2.5, 'PN' + pn, 7, 'middle', INK, ' stroke="none"');
}

function drawEl(e) {
  const t = e.type;
  if (t === 'pin_in' || t === 'pin_io' || t === 'osc') {
    const x = e.cx - 20;
    let s = pinFlag(x, e.cy, e.pn, t === 'pin_io' ? 'io' : 'in');
    const name = e.outs[0].replace(/^n(?=[A-Z])/, '');
    s += text(x, e.cy - 9, t === 'osc' ? 'OSC (ceramic resonator)' : name, 7.4, 'start', INK, ' stroke="none" font-weight="bold"');
    const pu = /pullup=(\S+)/.exec(e.line), ser = /series=(\S+)/.exec(e.line);
    if (pu) s += text(x, e.cy + 14, pu[1].toUpperCase() + ' to VCC', 6, 'start', MUTE, ' stroke="none"');
    if (ser) s += text(x, e.cy + 14, '400R series, diode clamp, 5K to VS', 6, 'start', MUTE, ' stroke="none"');
    e.pin = []; e.opin = [[x + 34, e.cy]];
    return s;
  }
  if (t === 'buf_ef') return triangle(e, { w: 14 });
  if (t === 'inv') return triangle(e, { bub: true });
  if (t === 'inv_rtl') return triangle(e, { bub: true }) + text(e.cx, e.cy - 11, 'RTL', 6, 'middle', MUTE, ' stroke="none"');
  if (/^nor\d/.test(t)) return orGate(e, +/\d/.exec(t)[0]) + (/rtl/.test(t) ? text(e.cx - 10, e.cy - 15, 'RTL', 6, 'middle', MUTE, ' stroke="none"') : '');
  if (t === 'dff') return box(e, [{ name: 'D' }, { name: '', edge: true, inv: e.inv[1] }, { name: 'R' }], [{ name: 'Q' }], '');
  if (t === 'tff') return box(e, [{ name: 'T', edge: true, inv: e.inv[0] }, { name: 'R' }],
    [{ name: 'Q' }, { name: 'Q', bar: true }], '');
  if (t === 'dlatch') {
    const nq = /^NQ/.test(e.outs[0]);
    return box(e, [{ name: 'D' }, { name: 'C', inv: e.inv[1] }], [{ name: 'Q', bar: nq }], 'latch');
  }
  if (t === 'out3') {
    const { cx, cy } = e, w = 52, h = 28;
    e.pin = [[cx - w / 2, cy - 7], [cx - w / 2, cy + 7]]; e.opin = [[cx + w / 2, cy]];
    return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" fill="#fff"/>` +
      text(cx, cy - 1, '3 LEVEL', 7, 'middle', INK, ' stroke="none"') + text(cx, cy + 8, 'OUTPUT', 7, 'middle', INK, ' stroke="none"') +
      text(cx - w / 2 + 2, cy - 5, 'S', 5, 'start', MUTE, ' stroke="none"') + text(cx - w / 2 + 2, cy + 9, 'V', 5, 'start', MUTE, ' stroke="none"');
  }
  if (t === 'pin_oc') {
    let s = triangle(e, { w: 14 });
    const x = e.cx - 9.5;                                  // open collector: the underlined diamond
    s += `<path d="M${x + 4.5},${e.cy} l2.2,-2.2 l2.2,2.2 l-2.2,2.2 Z" fill="none" stroke-width="0.5"/>` + line(x + 4, e.cy + 3.2, x + 10.4, e.cy + 3.2, ' stroke-width="0.5"');
    return s;
  }
  if (t === 'pin_ts') {
    let s = triangle(e, { w: 14 });
    const ex = e.cx, ey = e.cy + 4.7;                      // enable from below, active low, as drawn
    s += line(ex - 1, ey + 11, ex - 1, ey + 5.6) + `<circle cx="${ex - 1}" cy="${ey + 2.8}" r="2.8" fill="#fff"/>`;
    e.pin.push([ex - 1, ey + 11]);
    return s;
  }
  if (t === 'pin_tp' || t === 'pin_tpn') return triangle(e, { bub: t === 'pin_tpn', w: 14 });
  throw new Error('no symbol for ' + t);
}

// ---- draw ----
const body = [], wires = [], labels = [], dots = [];
// Symbols the original draws pointing left or up (drawing hints only; the netlist holds the logic and the grid square)
const ORIENT = { cc3: 'left', cc4: 'left', cr: 'left', crn: 'left', en: 'left', ba0: 'left', ba1: 'left',
  sck: 'up', dA0: 'up', lck1: 'up', lck2: 'up' };
for (const e of els) {
  let s = drawEl(e);
  e.ind = e.pin.map(() => [-1, 0]); e.outd = e.opin.map(() => [1, 0]);
  if (e.type === 'pin_ts') e.ind[1] = [0, 1];
  const o = e.orient = ORIENT[e.id];
  if (o === 'left') {
    s = `<g transform="translate(${2 * e.cx},0) scale(-1,1)">${s}</g>`;
    const m = ([x, y]) => [2 * e.cx - x, y];
    e.pin = e.pin.map(m); e.opin = e.opin.map(m); e.ind = e.ind.map(([dx, dy]) => [-dx, dy]); e.outd = e.outd.map(([dx, dy]) => [-dx, dy]);
  } else if (o === 'up') {
    s = `<g transform="rotate(-90 ${e.cx} ${e.cy})">${s}</g>`;
    const r = ([x, y]) => [e.cx + (y - e.cy), e.cy - (x - e.cx)];
    e.pin = e.pin.map(r); e.opin = e.opin.map(r); e.ind = e.ind.map(([dx, dy]) => [dy, -dx]); e.outd = e.outd.map(([dx, dy]) => [dy, -dx]);
  }
  body.push(`<g id="${e.id}">${s}</g>`);
}
const stubLabel = (x, y, [dx, dy], s, fill, bold) => {
  const ex = x + dx * 6, ey = y + dy * 6;
  const anchor = dx < 0 ? 'end' : dx > 0 ? 'start' : 'middle';
  const ty = dy > 0 ? ey + 7.5 : dy < 0 ? ey - 2.5 : ey + (bold ? -2.4 : 2.3);
  const tx = dx < 0 ? ex - 1 : dx > 0 ? (bold ? x + 1.5 : ex + 1) : ex;
  return [line(x, y, ex, ey), text(tx, ty, s, 6.6, anchor, fill, ' stroke="none"' + (bold ? ' font-weight="bold"' : ''))];
};

// output flags for the pins the chip drives
for (const e of els) {
  if (!/^pin_(tp|tpn|ts)$|^out3$/.test(e.type) && !(e.type === 'pin_oc' && e.pn)) continue;
  const [ox, oy] = e.opin[0], fx = Math.max(ox + 6, X0 + colIx('BI') * CW);   // the original lines its output pins up at BI
  wires.push(line(ox, oy, fx, oy));
  body.push(pinFlag(fx, oy, e.pn, 'out') + text(fx, oy - 9, e.outs[0], 7.4, 'start', INK, ' stroke="none" font-weight="bold"'));
  e.flagged = true;
}

// which inputs get a wire: the driver is in the same row, to the left, within 6 columns, with nothing in between
const rowEls = {}; for (const e of els) (rowEls[e.row] = rowEls[e.row] || []).push(e);
const wired = new Set();
for (const e of els) e.ins.forEach((n0, k) => {
  const n = real(n0); if (n === '-' || n === 'VCC' || n === 'GND') return;
  let ds = drivers[n]; if (!ds) return;
  if (ds.length > 1) ds = ds.filter(x => /^pin_io$/.test(x.e.type));   // a data pin node: its pin is the source drawn
  if (ds.length !== 1) return;
  const d = ds[0].e;
  const far = /^pin_(in|io)$|^osc$/.test(d.type) ? 99 : 6;          // a pin's line runs as far as its buffer
  if (d === e || d.row !== e.row || d.col >= e.col || e.col - d.col > far || d.flagged || d.orient || e.orient) return;
  if (rowEls[e.row].some(o => o !== d && o !== e && o.col > d.col && o.col < e.col && Math.abs(o.cy - e.cy) < RH * 0.4)) return;
  if (e.type === 'pin_ts' && k === 1) return;              // the enable comes from above
  wired.add(e.id + ':' + k);
  const [ox, oy] = d.opin[ds[0].k], [ix, iy] = e.pin[k];
  const tied = e.ins.length === 2 && e.ins[0] === e.ins[1];
  const mx = ix - ox > 30 && !tied ? Math.round((ox + ix) / 2) : Math.max(ox + 3, ix - 5);
  if (Math.abs(oy - iy) < 0.1) wires.push(line(ox, oy, ix, iy));
  else { wires.push(`<polyline points="${ox},${oy} ${mx},${oy} ${mx},${iy} ${ix},${iy}" fill="none"/>`); }
});
// junction dots where one output wires to two inputs of the same gate (the tied NORs)
for (const e of els) if (e.ins.length === 2 && e.ins[0] === e.ins[1] && wired.has(e.id + ':0') && wired.has(e.id + ':1')) {
  const [ix, iy] = e.pin[0], [, iy2] = e.pin[1];
  const d = drivers[real(e.ins[0])][0].e, [ox, oy] = d.opin[0];
  const mx = ix - ox > 30 ? Math.round((ox + ix) / 2) : Math.max(ox + 3, ix - 5);
  dots.push(`<circle cx="${mx}" cy="${oy}" r="1.3" fill="${INK}" stroke="none"/>`);
}

// input stubs and labels
for (const e of els) e.ins.forEach((n0, k) => {
  if (n0 === '-' || wired.has(e.id + ':' + k)) return;
  const [ix, iy] = e.pin[k];
  const n = real(n0);
  const lab = n === 'VCC' ? '1 (VCC)' : n0 + (pinOfNet[n] ? '' : '');
  if (e.type === 'pin_ts' && k === 1) { labels.push(text(ix + 2.5, iy + 9, lab, 6.6, 'start', ACC, ' stroke="none"')); return; }
  const [w, t] = stubLabel(ix, iy, e.ind[k], lab, ACC, false);
  wires.push(w); labels.push(t);
});
// output stubs and names (named nets always; generated names n_... only when not wired onward)
for (const e of els) e.outs.forEach((o, k) => {
  if (o === '-' || e.flagged) return;
  const [ox, oy] = e.opin[k];
  const wiredOn = (loads[o] || []).filter(l => wired.has(l.e.id + ':' + l.k)).length;
  const total = (loads[o] || []).length + (Object.keys(alias).some(a => alias[a] === o) ? (loads[Object.keys(alias).find(a => alias[a] === o)] || []).length : 0);
  if (wiredOn && wiredOn === total && /^n_/.test(o)) return;
  const shown = o + (Object.entries(alias).filter(([, b]) => b === o).map(([a]) => ' = ' + a).join(''));
  const [w, t] = stubLabel(ox, oy, e.outd[k], shown, INK, true);
  if (!wiredOn) wires.push(w);
  labels.push(t);
});
// element names, grid squares and power marks
for (const e of els) {
  if (/^pin_(in|io)$|^osc$/.test(e.type)) continue;
  const h = /^(dff|tff|dlatch)$/.test(e.type) ? 22 : /^nor/.test(e.type) ? Math.max(2, +/\d/.exec(e.type)[0]) * P / 2 + 2.5 : 8.5;
  if (e.type === 'pin_ts') labels.push(text(e.cx - 12, e.cy + 14, e.id, 5.6, 'end', MUTE, ' stroke="none"'));
  else if (e.orient === 'up') labels.push(text(e.cx + 10, e.cy + 2, e.id, 5.6, 'start', MUTE, ' stroke="none"'));
  else labels.push(text(e.cx, e.cy + h + 7.5, e.id, 5.6, 'middle', MUTE, ' stroke="none"'));
  if (e.pwr && e.pwr !== 'R') labels.push(text(e.cx + 6, e.cy - h - 2.5, e.pwr, 7, 'start', '#1d4ed8', ' stroke="none" font-weight="bold"'));
}

// the original's dashed box round the select outputs, which refers to their cell circuit
{
  const x = X0 + colIx('BA') * CW + 4, y = Y0 + 28.6 * RH, w = colIx('BH') * CW - colIx('BA') * CW + 20, h = 4.2 * RH;
  body.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke-dasharray="8 5" stroke-width="0.6"/>`);
  labels.push(text(x + w / 2, y + h - 8, 'SEE CCT. DIAGRAM (cell circuits, sheet "PINS ROMCS, RAMCS")', 7, 'middle', INK, ' stroke="none"'));
}
// ---- frame, grid and title block ----
const frame = [];
frame.push(`<rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="none" stroke="${INK}" stroke-width="1.6"/>`);
frame.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" fill="none" stroke="${INK}" stroke-width="0.8"/>`);
for (let c = 0; c <= COLS.length; c++) {
  const x = X0 + c * CW;
  frame.push(line(x, Y0, x, Y1, ` stroke="${GRIDC}" stroke-width="0.35"`));
  if (c < COLS.length) {
    const gc = INK;
    frame.push(text(x + CW / 2, Y0 - 12, COLS[c], 9, 'middle', gc, ' stroke="none"'));
    frame.push(text(x + CW / 2, Y1 + 15, COLS[c], 9, 'middle', gc, ' stroke="none"'));
    frame.push(line(x, Y0 - 8, x, Y0, ` stroke="${INK}" stroke-width="0.6"`), line(x, Y1, x, Y1 + 5, ` stroke="${INK}" stroke-width="0.6"`));
  }
}
for (let r = 0; r <= NROWS; r++) {
  const y = Y0 + r * RH;
  frame.push(line(X0, y, X1, y, ` stroke="${GRIDC}" stroke-width="0.35"`));
  if (r < NROWS) {
    frame.push(text(X0 - 14, y + RH / 2 + 3, String(r + 1), 9, 'middle', INK, ' stroke="none"'));
    frame.push(text(X1 + 14, y + RH / 2 + 3, String(r + 1), 9, 'middle', INK, ' stroke="none"'));
  }
}
const ver = (() => { try { return execSync('git log -1 --format="%h %cs" -- ula/2c210.net', { cwd: path.join(__dirname, '..') }).toString().trim(); } catch (_) { return ''; } })();
const TB = Y1 + 30, tb = [];
tb.push(`<rect x="${X0}" y="${TB}" width="${X1 - X0}" height="${H - 24 - TB}" fill="none" stroke="${INK}" stroke-width="0.8"/>`);
const c1 = X0 + 1250, c2 = X0 + 2300;
tb.push(line(c1, TB, c1, H - 12), line(c2, TB, c2, H - 12));
tb.push(text(X0 + 18, TB + 40, 'ZX81 ULA 2C210 — LOGIC', 30, 'start', INK, ' stroke="none" font-weight="bold"'));
tb.push(text(X0 + 18, TB + 66, 'Redrawn from Ferranti Electronics drawing LD6679/ULA2C210/1, issue 1, 12/01/82 (Ferranti Microelectronics Centre, Hollinwood, Oldham).', 12, 'start', INK, ' stroke="none"'));
tb.push(text(X0 + 18, TB + 84, 'Drawn by program from the netlist ula/2c210.net' + (ver ? ` (version ${ver})` : '') + ', branch zx81-ULA of github.com/fdimer/z80-bench. Not a Ferranti document.', 12, 'start', INK, ' stroke="none"'));
tb.push(text(X0 + 18, TB + 102, 'Each element sits in the grid square the original gives it, so this sheet lines up with the scan. Sheet 1: logic. Sheet 2: notes. Sheets 3–4: net cross-reference.', 12, 'start', MUTE, ' stroke="none"'));
tb.push(text(X0 + 18, TB + 126, `${els.length} elements · ${Object.keys(drivers).length} nets`, 12, 'start', MUTE, ' stroke="none"'));
const legX = c1 + 18;
tb.push(text(legX, TB + 22, 'READING THE SHEET', 11, 'start', INK, ' stroke="none" font-weight="bold"'));
const leg = [
  ['Orange name at an input', 'the net it comes from; a wire is drawn only when the driver stands just to its left'],
  ['Bold name at an output', 'the net the element drives; the cross-reference gives every load'],
  ['R/2, R/3 in blue', "gate power as marked by Ferranti (unmarked gates are R); delays: Ferranti Table 2.1"],
  ['Grey name under a symbol', 'the element\'s name in the netlist; its grid square is its place on the sheet'],
  ['RTL, OC diamond', 'resistor-transistor stage; open-collector output'],
  ['Bubble on a clock', 'acts on the falling edge; latches (C) are transparent while C is high'],
];
leg.forEach(([a, b], i) => { tb.push(text(legX, TB + 44 + i * 18, a, 10, 'start', INK, ' stroke="none" font-weight="bold"'), text(legX + 175, TB + 44 + i * 18, b, 10, 'start', INK, ' stroke="none"')); });
const tX = c2 + 18;
tb.push(text(tX, TB + 22, 'SOURCE AND TERMS', 11, 'start', INK, ' stroke="none" font-weight="bold"'));
[
  'Ferranti archive, catalogued by Happy Little Diodes (youtu.be/jiW3P1rJRMc).',
  'The archive is presented for preserving material of historical interest and for',
  'non-commercial, educational and archival research only. Any commercial use,',
  'including in the manufacture, marketing or sale of goods, is prohibited by',
  'Sky UK Limited. This redrawing is a transcription of that drawing:',
  'STRICTLY NOT FOR COMMERCIAL USE OF ANY KIND.',
].forEach((s, i) => tb.push(text(tX, TB + 44 + i * 16, s, 10, 'start', i === 5 ? ACC : INK, ' stroke="none"' + (i === 5 ? ' font-weight="bold"' : ''))));

function svgDoc(w, h, inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}" style="${FONT}">
<rect width="${w}" height="${h}" fill="#fff"/>
${inner}
</svg>
`;
}
const sheet1 = svgDoc(W, H, [
  frame.join('\n'), tb.join('\n'),
  `<g stroke="${INK}" stroke-width="0.7" fill="none">${wires.join('\n')}</g>`,
  `<g stroke="${INK}" stroke-width="0.8">${body.join('\n')}</g>`,
  dots.join('\n'), labels.join('\n'),
].join('\n'));

// ---- notes sheet and cross-reference (A3 landscape) ----
const AW = 1191, AH = 842;
function page(title, lines, n, of) {
  const s = [`<rect x="24" y="24" width="${AW - 48}" height="${AH - 48}" fill="none" stroke="${INK}" stroke-width="1"/>`];
  s.push(text(44, 58, title, 18, 'start', INK, ' stroke="none" font-weight="bold"'));
  s.push(text(AW - 44, 58, `ZX81 ULA 2C210 — sheet ${n} of ${of}`, 10, 'end', MUTE, ' stroke="none"'));
  s.push(line(44, 68, AW - 44, 68, ` stroke="${INK}" stroke-width="0.6"`));
  s.push(text(44, AH - 34, 'Redrawn from Ferranti LD6679/ULA2C210/1 issue 1 (Ferranti archive). Strictly not for commercial use of any kind.', 8, 'start', MUTE, ' stroke="none"'));
  return svgDoc(AW, AH, s.join('\n') + lines.join('\n'));
}
// cross-reference
const nets = Object.keys(drivers).sort((a, b) => (/^n_/.test(a) - /^n_/.test(b)) || a.localeCompare(b, 'en', { numeric: true }));
const xrows = nets.map(n => {
  const ds = drivers[n].map(({ e }) => `${e.id} ${e.grid}`).join(', ');
  const al = Object.entries(alias).filter(([, b]) => b === n).map(([a]) => a);
  const ls = [n, ...al].flatMap(m => loads[m] || []).map(({ e }) => `${e.id} ${e.grid}`);
  const pin = pinOfNet[n] ? ` (PN${pinOfNet[n]})` : (drivers[n].find(d => d.e.flagged) ? ` (PN${drivers[n].find(d => d.e.flagged).e.pn})` : '');
  return { n: n + (al.length ? ' = ' + al.join(', ') : '') + pin, ds, ls: [...new Set(ls)].join(', ') || '—' };
});
const xpages = [];
{
  const colW = [150, 120, 250], pageCols = 2, gap = 40, lh = 11.2, top = 92, bottom = AH - 50;
  const perCol = Math.floor((bottom - top) / lh);
  // wrap long load lists
  const flat = [];
  const maxChars = 62;
  for (const r of xrows) {
    const parts = []; let cur = '';
    for (const tok of r.ls.split(', ')) { if ((cur + ', ' + tok).length > maxChars && cur) { parts.push(cur + ','); cur = tok; } else cur = cur ? cur + ', ' + tok : tok; }
    parts.push(cur);
    parts.forEach((p, i) => flat.push({ n: i ? '' : r.n, ds: i ? '' : r.ds, ls: p, first: i === 0 }));
  }
  const per = perCol * pageCols;
  for (let p = 0; p * per < flat.length; p++) {
    const s = [];
    for (let c = 0; c < pageCols; c++) {
      const x = 44 + c * (colW[0] + colW[1] + colW[2] + gap);
      s.push(text(x, top - 8, 'NET', 8, 'start', MUTE, ' stroke="none" font-weight="bold"'), text(x + colW[0], top - 8, 'DRIVEN BY', 8, 'start', MUTE, ' stroke="none" font-weight="bold"'), text(x + colW[0] + colW[1], top - 8, 'GOES TO', 8, 'start', MUTE, ' stroke="none" font-weight="bold"'));
      flat.slice(p * per + c * perCol, p * per + (c + 1) * perCol).forEach((r, i) => {
        const y = top + 6 + i * lh;
        if (r.first) s.push(line(x, y - 8.5, x + colW[0] + colW[1] + colW[2], y - 8.5, ` stroke="${GRIDC}" stroke-width="0.5"`));
        s.push(text(x, y, r.n, 7.6, 'start', INK, ' stroke="none" font-weight="bold"'), text(x + colW[0], y, r.ds, 7.6, 'start', INK, ' stroke="none"'), text(x + colW[0] + colW[1], y, r.ls, 7.6, 'start', INK, ' stroke="none"'));
      });
    }
    xpages.push(s);
  }
}
const of = 2 + xpages.length;
const notes = [
  ['What this is', [
    'The logic of the Ferranti ULA 2C210 in the Sinclair ZX81, redrawn by program from the gate-level netlist ula/2c210.net. The netlist was',
    'transcribed line by line from Ferranti drawing LD6679/ULA2C210/1 issue 1 (12/01/82) and every line checked against that drawing.',
    'It runs: ula/sim.js simulates it with Ferranti\'s gate delays, and the testbench checks it against the ZX81 ROM\'s picture.',
  ]],
  ['How the sheet is laid out', [
    'The border carries the original\'s grid (rows 1–37, columns A–BJ) and each element sits in the square where the original draws it (every',
    'grid square was re-read from the scan for this sheet). Symbols the original draws pointing left or up are drawn the same way here.',
    'Long wires are not redrawn: an input names its net instead. A wire is drawn only from a driver just to the left in the same row',
    '(the delay chains, the keyboard and port drivers, the address outputs). The cross-reference sheets give each net\'s driver and every load.',
  ]],
  ['Symbols', [
    'Triangle: buffer; with a bubble, an inverter. The plain triangles behind the input pins are the emitter-follower buffers (EF on the original).',
    'RTL: resistor-transistor stage. The original\'s crossed circles (crossings under the wiring) are left out.',
    'NOR: OR shape with a bubble; the number of inputs follows the netlist (nor2 … nor8). Inputs drawn tied together make an inverter.',
    'Boxes: D-type flip-flop (D, clock, reset R), T-type (toggle on the clock, reset R, outputs Q and Q-bar) and D latch (transparent while C high).',
    'A bubble on a clock or latch input inverts it: the flip-flop acts on the falling edge. Resets are active high.',
    'Output flags PNnn: the package pin. OC diamond: open-collector driver onto a data pin. A tri-state output\'s enable comes in from below, active low.',
  ]],
  ['Power marks and delays', [
    'Ferranti marks a gate R/2 or R/3 when it has two or three current sources (faster, more drive); unmarked gates are R. The marks are shown',
    'in blue as on the original. The simulator takes each gate\'s delay from Ferranti\'s Table 2.1 (ULA 2C000/5C000 series) by power, fan-in',
    'and fan-out. Buffers, RTL stages and pin cells use estimates.',
  ]],
  ['Pins', [
    'Inputs (16K pull-up to VCC on chip): D0–D7 (bidirectional), KB0–KB4, USA, TAPE, N.MREQ, N.M1, A15, N.HALT, A14, N.WR, N.IORQ, N.RD.',
    'Outputs: N.PHI (PN14), N.NMI (PN15, open collector, 5K pull-up), TV/TAPE (PN16, three levels), A0\'–A8\' (tri-state), RAM N.CS (PN12),',
    'ROM N.CS (PN13). Supply: VCC PN40, GND PN34. Oscillator: PN35, 6.5 MHz ceramic resonator.',
  ]],
  ['Terms', [
    'The Ferranti archive (catalogued by Happy Little Diodes, youtu.be/jiW3P1rJRMc) is presented for preserving material of historical interest',
    'and for non-commercial, educational and archival research. Any commercial use of the documents or their contents, including in connection',
    'with the manufacture, marketing or sale of goods, is prohibited by Sky UK Limited. This sheet is a transcription of a Ferranti drawing, so',
    'the same terms apply: strictly not for commercial use of any kind, including making or selling replacement chips built from it.',
  ]],
];
const nl = []; let ny = 100;
for (const [h, ps] of notes) {
  nl.push(text(44, ny, h, 12, 'start', INK, ' stroke="none" font-weight="bold"')); ny += 18;
  for (const p of ps) { nl.push(text(44, ny, p, 9.6, 'start', INK, ' stroke="none"')); ny += 14; }
  ny += 12;
}

const dir = process.argv[2] || '.';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '2c210-1-logic.svg'), sheet1);
fs.writeFileSync(path.join(dir, '2c210-2-notes.svg'), page('Notes', nl, 2, of));
xpages.forEach((s, i) => fs.writeFileSync(path.join(dir, `2c210-${3 + i}-xref.svg`), page('Net cross-reference', s, 3 + i, of)));
console.log(`wrote ${2 + xpages.length} sheets to ${dir}`);
