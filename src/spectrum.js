// Sinclair ZX Spectrum 48K machine model for Z80 Bench: the issue 4A/4B board.
// From Sinclair's issue 4A/4B circuit diagram:
//   IC1   ULA (Ferranti 6C001-7 or later). From a 14 MHz crystal it makes the 3.5 MHz CPU clock and the 7 MHz dot
//         clock. It reads the screen from the lower 16K of RAM, which it owns: it drives that RAM's address pins
//         (A0-A6, pins 5-11), RAS (35), CAS (1) and WE (DRAMWE, 4), and the RAM's data lines are its own data pins
//         D0-D7 (18, 21, 22, 25, 27, 29, 30, 31). It decodes the ROM's select (ROMCS, 34) from A14, A15 (36, 37) and
//         MREQ (38). Port FE (any even port: IORQ on 33 with A0 low) reads the keyboard (KB0-KB4, pins 19, 20, 23,
//         24, 26) and the EAR input, and writes the border colour, MIC and EAR (pin 28, MIC/TAPE). It asks for an
//         interrupt (INT, 12) once a frame and stops the CPU's clock (CPU CLK, 32) while it needs the lower RAM.
//         Its picture leaves as Y, U and V (17, 15, 16) for the LM1889 colour encoder (IC14).
//   IC2   Z80A CPU.
//   IC3, IC4  74LS157: the CPU's address for the lower RAM, row (A0-A6) then column (A7-A13), through 330 ohm
//         resistors, so the ULA's own address wins when it reads the screen.
//   IC5   16K ROM (23128).
//   IC6-IC13  4116 16K x 1 dynamic RAMs: 4000h-7FFFh, one per data bit. Their data lines are the ULA's data bus,
//         joined to the CPU's through 470 ohm resistors (R1-R8), so the ULA can use them while the CPU uses the ROM
//         or the upper RAM.
//   IC15-IC22  4532 32K x 1 dynamic RAMs (half-good 4164s; link DK1 picks the half): 8000h-FFFFh, one per data bit.
//   IC25, IC26  74LS157: the upper RAM's row and column address. IC23 (74LS32) and IC24 (74LS00): its RAS, CAS
//         and WRITE from MREQ, A14, A15, RFSH, RD and WR.
// Timing (the ULA, 48K): a line is 224 T-states (128 for the 256 dots of the picture, 24 right border, 48 blanking
// and sync, 24 left border), a frame 312 lines, 69,888 T-states (about 50.08 a second). INT is low for the first 32
// T-states of the frame. The first dot of the picture is shown 14,336 T-states after INT starts (line 64). While a
// line of the picture is drawn, the ULA reads two bytes (bitmap, attribute) twice in every 8 T-states. A CPU access
// to 4000h-7FFFh, or to an even port, in that time has its clock held until the ULA is done: from 14,335 on, for 128
// T-states of each of the 192 lines, a cycle that starts at T-state 0-7 of an 8 T-state group is held 6, 5, 4, 3, 2,
// 1, 0, 0 T-states. The ULA sees only the address: the processor's internal cycles that leave an address on the bus
// in that range are held too.
const SPEC = {
  CPU_HZ: 3500000, LINE_T: 224, LINES: 312, FRAME_T: 69888, INT_T: 32, DISP_T: 14336, CONT_T: 14335,
  FIRST: 16, FW: 352, FH: 296, BORDER: 48,           // the picture kept: lines 16-311, 48 dots of border each side
  DELAY: [6, 5, 4, 3, 2, 1, 0, 0],
  // colours 0-7, then bright 8-15 (the bright black is still black)
  RGB: [0x000000, 0x0000D8, 0xD80000, 0xD800D8, 0x00D800, 0x00D8D8, 0xD8D800, 0xD8D8D8, 0x000000, 0x0000FF, 0xFF0000, 0xFF00FF, 0x00FF00, 0x00FFFF, 0xFFFF00, 0xFFFFFF],
  // the keyboard: eight half-rows, each read with one of A8-A15 low, five keys on KB0-KB4 (bit 0 nearest the edge)
  ROWS: [['CAPS SHIFT', 'Z', 'X', 'C', 'V'], ['A', 'S', 'D', 'F', 'G'], ['Q', 'W', 'E', 'R', 'T'], ['1', '2', '3', '4', '5'],
         ['0', '9', '8', '7', '6'], ['P', 'O', 'I', 'U', 'Y'], ['ENTER', 'L', 'K', 'J', 'H'], ['SPACE', 'SYMBOL SHIFT', 'M', 'N', 'B']]
};
SPEC.KEYPOS = {}; SPEC.ROWS.forEach((r, row) => r.forEach((k, bit) => { SPEC.KEYPOS[k] = [row, bit]; }));
function specCrc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c >>> 1 ^ (c & 1 ? 0xEDB88320 : 0); } return ~c >>> 0; }

// ---- Cassette: a TZX or TAP file is turned into the signal it describes: stretches of tape at one level with their
// lengths in T-states (TZX times are Spectrum T-states already). While Play is pressed the tape moves with emulated
// time, and its level is what bit 6 of port FE reads, so the ROM's loader and the custom loaders of games read it bit
// by bit as from a real cassette. A "stop the tape" block (a pause of 0) releases Play. A TAP file is a list of blocks
// in the ROM's standard format; it is read as the TZX standard-speed blocks it stands for.
class SpecTape {
  constructor(bytes) {
    const tzx = bytes.length > 10 && String.fromCharCode(...bytes.subarray(0, 7)) === 'ZXTape!';
    const b = tzx ? bytes : SpecTape.tapToTzx(bytes);
    let cap = 1 << 16, n = 0, dur = new Uint32Array(cap), lvl = new Uint8Array(cap), level = 0;
    const blocks = [], stops = new Set(), notes = [];
    const push = (t, l) => {
      if (t <= 0) return; t = Math.round(t);
      if (n && lvl[n - 1] === l && dur[n - 1] + t < 0xFFFFFFFF) { dur[n - 1] += t; return; }
      if (n === cap) { cap *= 2; const d2 = new Uint32Array(cap), l2 = new Uint8Array(cap); d2.set(dur); l2.set(lvl); dur = d2; lvl = l2; }
      dur[n] = t; lvl[n] = l; n++;
    };
    const pulse = t => { level ^= 1; push(t, level); };
    // a pause: 1 ms at the opposite level first, to finish the last pulse, then low (as the TZX format says)
    const pause = ms => { if (ms > 0) { level ^= 1; push(3500, level); if (ms > 1) { level = 0; push((ms - 1) * 3500, 0); } } };
    const data = (off, len, zero, one, last) => {
      for (let i = 0; i < len; i++) { const v = b[off + i], bits = i === len - 1 ? last || 8 : 8; for (let k = 0; k < bits; k++) { const t = v & (0x80 >> k) ? one : zero; pulse(t); pulse(t); } }
    };
    const w = i => b[i] | b[i + 1] << 8, w3 = i => b[i] | b[i + 1] << 8 | b[i + 2] << 16, dw = i => (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
    const text = (i, len) => String.fromCharCode(...b.subarray(i, i + len)).replace(/[^\x20-\x7E]/g, ' ').trim();
    // a run of plain pulses (a recording, or a tape made from one) may hold blocks in the ROM's format: a leader of
    // equal pulses, two short sync pulses, then bytes, each bit two equal pulses, a 1 twice as long as a 0. A block
    // is kept only if its checksum (all its bytes XORed) is 0.
    let run = null;
    const endRun = () => {
      const r = run; run = null; if (!r || r.p.length < 600) return;
      const found = SpecTape.findBlocks(r.p);
      const at = blocks.indexOf(r.blk), runEnd = r.blk.end;
      found.forEach((f, q) => {
        const bl = q ? { block: r.blk.block, seg: r.seg0 + f.i0 } : r.blk;
        bl.data = f.data; bl.desc = (q ? '' : r.blk.desc.replace(/(tone and )?pulses$/, '')) + 'recorded ' + SpecTape.what(f.data); bl.end = q + 1 < found.length ? r.seg0 + found[q + 1].i0 : runEnd;
        if (q) blocks.splice(at + q, 0, bl);
      });
    };
    const offs = []; let i = 10;
    const size = (t, i) => {
      switch (t) {
        case 0x10: return 4 + w(i + 2); case 0x11: return 18 + w3(i + 15); case 0x12: return 4; case 0x13: return 1 + 2 * b[i];
        case 0x14: return 10 + w3(i + 7); case 0x15: return 8 + w3(i + 5); case 0x18: case 0x19: return 4 + dw(i);
        case 0x20: case 0x23: case 0x24: return 2; case 0x21: return 1 + b[i]; case 0x22: case 0x25: case 0x27: return 0;
        case 0x26: return 2 + 2 * w(i); case 0x28: return 2 + w(i); case 0x2A: return 4; case 0x2B: return 5;
        case 0x30: return 1 + b[i]; case 0x31: return 2 + b[i + 1]; case 0x32: return 2 + w(i); case 0x33: return 1 + 3 * b[i];
        case 0x35: return 20 + dw(i + 16); case 0x5A: return 9; default: return 4 + dw(i);
      }
    };
    while (i < b.length) { const t = b[i]; offs.push(i); i += 1 + size(t, i + 1); }
    if (i > b.length) notes.push('the last block is cut short');
    let group = '', loopAt = -1, loopN = 0, fresh = true;
    for (let k = 0; k < offs.length; k++) {
      const o = offs[k], t = b[o], j = o + 1; if (j >= b.length) break;
      const start = n, mark = (d, off, len) => blocks.push({ seg: start, block: k, desc: (group ? group + ': ' : '') + d, off, len });
      const wasFresh = fresh; if (t === 0x12 || t === 0x13) fresh = false; else if ([0x10, 0x11, 0x14, 0x15, 0x20].includes(t)) { fresh = true; endRun(); }
      switch (t) {
        case 0x10: { const len = w(j + 2), off = j + 4; mark((tzx ? 'standard ' : '') + SpecTape.what(b.subarray(off, off + len)), off, len); for (let p = b[off] < 128 ? 8063 : 3223; p > 0; p--) pulse(2168); pulse(667); pulse(735); data(off, len, 855, 1710, 8); pause(w(j)); break; }
        case 0x11: { const len = w3(j + 15), off = j + 18; mark('turbo ' + SpecTape.what(b.subarray(off, off + len)), off, len); for (let p = w(j + 10); p > 0; p--) pulse(w(j)); pulse(w(j + 2)); pulse(w(j + 4)); data(off, len, w(j + 6), w(j + 8), b[j + 12]); pause(w(j + 13)); break; }
        case 0x12: { if (wasFresh) { mark('tone and pulses'); run = { p: [], blk: blocks[blocks.length - 1], seg0: n }; } for (let p = w(j + 2); p > 0; p--) { pulse(w(j)); if (run) run.p.push(w(j)); } break; }
        case 0x13: { if (wasFresh) { mark('pulses'); run = { p: [], blk: blocks[blocks.length - 1], seg0: n }; } for (let p = 0; p < b[j]; p++) { pulse(w(j + 1 + 2 * p)); if (run) run.p.push(w(j + 1 + 2 * p)); } break; }
        case 0x14: { const len = w3(j + 7), off = j + 10; mark('pure data, ' + len + ' bytes', off, len); data(off, len, w(j), w(j + 2), b[j + 4]); pause(w(j + 5)); break; }
        case 0x15: { const tps = w(j), len = w3(j + 5), off = j + 8, last = b[j + 4] || 8; mark(`direct recording, ${len} bytes`);
          for (let q = 0; q < len; q++) for (let r = 0; r < (q === len - 1 ? last : 8); r++) { level = b[off + q] & (0x80 >> r) ? 1 : 0; push(tps, level); }
          pause(w(j + 2)); break; }
        case 0x20: { const ms = w(j); if (ms) pause(ms); else { stops.add(n); mark('stop the tape'); } break; }
        case 0x21: group = text(j + 1, b[j]); break;
        case 0x22: group = ''; break;
        case 0x23: { const rel = (w(j) << 16) >> 16; if (rel) k += rel - 1; break; }
        case 0x24: loopAt = k; loopN = w(j); break;
        case 0x25: if (loopAt >= 0 && --loopN > 0) k = loopAt; else loopAt = -1; break;
        case 0x2A: stops.add(n); mark('stop the tape (48K)'); break;
        case 0x2B: level = b[j + 4] ? 1 : 0; break;
        case 0x30: notes.push(text(j + 1, b[j])); break;
        case 0x18: case 0x19: notes.push(`block type ${t.toString(16).toUpperCase()}h is not supported and was skipped`); break;
        default: break;
      }
      const lb = blocks[blocks.length - 1]; if (lb && lb.block === k) lb.end = n;
      if (run && lb) lb.end = n;
    }
    endRun();
    this.bytes = b; this.tzx = tzx; for (const bl of blocks) if (bl.off !== undefined) bl.data = b.subarray(bl.off, bl.off + bl.len);
    for (let q = 0; q < blocks.length; q++) if (blocks[q].end === undefined || blocks[q].end < blocks[q].seg) blocks[q].end = q + 1 < blocks.length ? blocks[q + 1].seg : n;
    this.dur = dur.subarray(0, n); this.lvl = lvl.subarray(0, n); this.n = n; this.blocks = blocks; this.stops = stops; this.notes = notes;
    this.total = 0; for (let q = 0; q < n; q++) this.total += this.dur[q];
  }
  // what a block holds: a header (flag 00h, 19 bytes) names the file
  static what(d) {
    const len = d.length;
    if (d[0] === 0 && len === 19) { const name = String.fromCharCode(...d.subarray(2, 12)).replace(/[^\x20-\x7E]/g, ' ').trim(); return `${['Program', 'Number array', 'Character array', 'Bytes'][d[1]] || 'Header'}: "${name}"`; }
    return (d[0] === 0xFF ? 'data' : 'block') + `, ${Math.max(0, len - 2)} bytes`;
  }
  // a TAP file: each block is its length (2 bytes) then the block (flag, data, checksum). As TZX blocks 10h, 1 s apart.
  static tapToTzx(b) {
    const out = [...'ZXTape!'].map(c => c.charCodeAt(0)).concat([0x1A, 1, 20]);
    for (let i = 0; i + 2 <= b.length;) {
      const len = b[i] | b[i + 1] << 8; if (!len) { i += 2; continue; }
      if (i + 2 + len > b.length) throw new Error('The TAP file is cut short in a block');
      out.push(0x10, 1000 & 255, 1000 >> 8, len & 255, len >> 8); for (let k = 0; k < len; k++) out.push(b[i + 2 + k]); i += 2 + len;
    }
    if (out.length === 10) throw new Error('Not a TAP or TZX tape file');
    return new Uint8Array(out);
  }
  // blocks in the ROM's format in a list of pulse lengths (T-states)
  static findBlocks(p) {
    const found = []; let i = 0;
    while (i + 256 < p.length) {
      let j = i + 1, sum = p[i];
      while (j < p.length && Math.abs(p[j] - sum / (j - i)) < sum / (j - i) * 0.2) { sum += p[j]; j++; }
      const lead = sum / (j - i);
      if (j - i >= 256 && j + 1 < p.length && p[j] + p[j + 1] < lead * 1.2) {
        const out = []; let k = j + 2, v = 0, nb = 0;
        while (k + 1 < p.length && p[k] < lead * 1.2 && p[k + 1] < lead * 1.2 && Math.abs(p[k] - p[k + 1]) < lead * 0.35) { v = v << 1 | (p[k] + p[k + 1] > lead * 1.2 ? 1 : 0); k += 2; if (++nb === 8) { out.push(v); v = 0; nb = 0; } }
        const d = new Uint8Array(out); let x = 0; for (const c of d) x ^= c;
        if (d.length >= 2 && x === 0) found.push({ data: d, i0: i, i1: k });
        i = Math.max(k, j + 1);
      } else i = j;
    }
    return found;
  }
}
// a recording as a TZX file: the pulses as pulse-sequence blocks; a gap longer than a pulse can be becomes a pause
SpecTape.fromPulses = (pulses, note = 'Recorded on the Z80 Bench ZX Spectrum emulator') => {
  const out = [...'ZXTape!'].map(c => c.charCodeAt(0)).concat([0x1A, 1, 20]);
  const t = [...note].map(c => c.charCodeAt(0) & 0x7F).slice(0, 255); out.push(0x30, t.length, ...t);
  let run = [], any = false;
  const flush = () => { while (run.length) { const n = Math.min(255, run.length); out.push(0x13, n); for (const v of run.splice(0, n)) out.push(v & 255, v >> 8); } };
  for (let i = 0; i < pulses.length; i++) {
    const v = Math.round(pulses[i]);
    if (i === 0 && v > 65535) continue;
    if (v > 65535) { flush(); const ms = Math.min(65535, Math.max(1, Math.round(v / 3500))); out.push(0x20, ms & 255, ms >> 8); continue; }
    if (v > 0) { run.push(v); any = true; }
  }
  flush();
  return any ? new Uint8Array(out) : null;
};
// a recording as a TAP file, when every block in it is in the ROM's format; otherwise null
SpecTape.tapFromPulses = pulses => {
  const blocks = SpecTape.findBlocks(pulses); if (!blocks.length) return null;
  const out = []; for (const f of blocks) { out.push(f.data.length & 255, f.data.length >> 8, ...f.data); }
  return new Uint8Array(out);
};

// ---- WAV files: as on the CPC bench (DC removed over 3 ms, a threshold that follows the signal, a floor above the hiss,
// edges at the zero crossings), in T-states at 3.5 MHz
SpecTape.readWav = bytes => {
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength), tag = i => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file (no RIFF WAVE header)');
  let fmt = null, data = null;
  for (let i = 12; i + 8 <= b.length;) {
    const id = tag(i), len = dv.getUint32(i + 4, true), body = i + 8;
    if (id === 'fmt ') { let f = dv.getUint16(body, true); const bits = dv.getUint16(body + 14, true); if (f === 0xFFFE && len >= 26) f = dv.getUint16(body + 24, true); fmt = { f, ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), align: dv.getUint16(body + 12, true), bits }; }
    else if (id === 'data') data = [body, Math.min(len, b.length - body)];
    i = body + len + (len & 1);
  }
  if (!fmt || !data) throw new Error('The WAV file has no ' + (fmt ? 'sound data' : 'format chunk'));
  const { f, ch, rate, align, bits } = fmt, by = bits >> 3;
  if (!(f === 1 && [8, 16, 24, 32].includes(bits) || f === 3 && (bits === 32 || bits === 64)) || !ch || !rate || align < ch * by) throw new Error(`WAV format not supported (format ${f}, ${bits} bits): use PCM or float`);
  const n = Math.floor(data[1] / align), x = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) {
      const o = data[0] + k * align + c * by;
      sum += f === 3 ? (bits === 32 ? dv.getFloat32(o, true) : dv.getFloat64(o, true)) : bits === 8 ? (b[o] - 128) / 128 : bits === 16 ? dv.getInt16(o, true) / 32768 : bits === 24 ? ((b[o] | b[o + 1] << 8 | b[o + 2] << 16) << 8 >> 8) / 8388608 : dv.getInt32(o, true) / 2147483648;
    }
    x[k] = sum / ch;
  }
  return { rate, x, bits, ch };
};
SpecTape.wavPulses = (x, rate) => {
  const n = x.length, W = Math.max(3, Math.round(rate * 0.003)), y = new Float32Array(n);
  let acc = 0; const half = W >> 1;
  for (let k = 0; k < Math.min(n, half); k++) acc += x[k];
  for (let k = 0; k < n; k++) {
    const add = k + half, sub = k - half - 1; if (add < n) acc += x[add]; if (sub >= 0) acc -= x[sub];
    const cnt = Math.min(n - 1, k + half) - Math.max(0, k - half) + 1; y[k] = x[k] - acc / cnt;
  }
  const Wn = Math.max(8, Math.round(rate * 0.005)), wp = [];
  for (let k = 0; k < n; k += Wn) { let m = 0; for (let j = k; j < Math.min(n, k + Wn); j++) m = Math.max(m, Math.abs(y[j])); wp.push(m); }
  wp.sort((p, q) => p - q);
  const sig = wp[Math.floor(wp.length * 0.9)] || 0, hiss = wp[Math.floor(wp.length * 0.1)] || 0;
  if (!sig) return [];
  const floor = Math.min(sig * 0.4, Math.max(sig * 0.03, hiss * 2)), decay = Math.exp(-1 / (rate * 0.02)), pulses = [], clk = SPEC.CPU_HZ / rate;
  let env = 0, state = 0, cross = 0, last = 0, first = true;
  for (let k = 1; k < n; k++) {
    const v = y[k], a = Math.abs(v); env = Math.max(a, env * decay);
    if ((v >= 0) !== (y[k - 1] >= 0)) cross = k - 1 + y[k - 1] / (y[k - 1] - v);
    const h = Math.max(floor, env * 0.25);
    if (state <= 0 && v > h || state >= 0 && v < -h) {
      const want = v > 0 ? 1 : -1;
      if (state !== want) { if (state !== 0) { pulses.push(Math.max(1, Math.round((cross - last) * clk))); } else if (first) { pulses.push(Math.max(1, Math.round(cross * clk))); first = false; } last = cross; state = want; }
    }
  }
  return pulses;
};
SpecTape.fromWav = (bytes, name) => {
  const w = SpecTape.readWav(bytes), pulses = SpecTape.wavPulses(w.x, w.rate);
  const t = SpecTape.fromPulses(pulses, `Converted from ${name || 'a WAV file'} (${w.rate} Hz, ${w.bits}-bit, ${w.ch === 1 ? 'mono' : w.ch + ' channels'}) by Z80 Bench`);
  if (!t) throw new Error('No tape signal was found in the WAV file');
  return t;
};
SpecTape.toWav = (tape, rate = 44100, opt = {}) => {
  let total = 0; for (let i = 0; i < tape.n; i++) total += tape.dur[i];
  const n = Math.ceil(total / SPEC.CPU_HZ * rate) + 1, bits = opt.bits || 8, by = bits >> 3, out = new Uint8Array(44 + n * by), dv = new DataView(out.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); dv.setUint32(4, 36 + n * by, true); put(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * by, true); dv.setUint16(32, by, true); dv.setUint16(34, bits, true); put(36, 'data'); dv.setUint32(40, n * by, true);
  const amp = opt.amp === undefined ? 0.8 : opt.amp;
  let seg = 0, left = tape.n ? tape.dur[0] : Infinity, t = 0;
  for (let k = 0; k < n; k++) {
    const at = (k / rate) * SPEC.CPU_HZ; while (seg < tape.n && at - t >= left) { t += left; seg++; left = seg < tape.n ? tape.dur[seg] : Infinity; }
    const s = seg < tape.n ? (tape.lvl[seg] ? amp : -amp) : 0;
    if (bits === 8) out[44 + k] = Math.round(s * 127 + 128); else dv.setInt16(44 + k * 2, Math.round(s * 32767), true);
  }
  return out;
};

// ---- the machine ----
class SpecMachine {
  constructor() {
    this.rom = new Uint8Array(0x4000).fill(0xFF); this.hasRom = false;
    this.ram = new Uint8Array(0xC000);                 // 4000h-FFFFh
    this.keys = new Uint8Array(8);                     // bit set = key down
    this.fb = new Uint8Array(SPEC.FW * SPEC.FH);       // the picture, as colour numbers 0-15
    this.bus = { read: a => this.read(a), write: (a, v) => this.write(a, v), input: p => this.input(p), output: (p, v) => this.output(p, v) };
    this.cpu = new Z80(this.bus); this.cpu.log = true; this.cpu.intVector = 0xFF;
    // each instruction starts its own clock count: the ULA's holds are worked out as its cycles happen
    const run = this.cpu.step.bind(this.cpu);
    this.cpu.step = () => { this.ct = 0; this.done = 0; this.wq = []; this.wqi = 0; this.lastA = this.cpu.pc; return run(); };
    this.tape = null; this.tapePlay = false; this.tapeIdx = 0; this.tapeRem = 0; this.tapeLevel = 0; this.tapePos = 0; this.rec = null; this.instant = true;
    this.audioRate = 0; this.abuf = new Float32Array(32768); this.aw = 0; this.audioT = 0; this.lvlSum = 0; this.lvlN = 0;
    this.contended = true;                             // the ULA holds the CPU (off: every access runs at full speed)
    this.issue = 3;                                    // the EAR threshold of issue 3 and later boards (issue 4A/4B included)
    this.reset();
  }
  loadRom(bytes) {
    if (bytes.length !== 0x4000) throw new Error('A Spectrum 48K ROM image is 16,384 bytes');
    this.rom.set(bytes); this.hasRom = true;
  }
  romCrc() { return specCrc32(this.rom); }
  // power on: the RAM keeps whatever it held (filled here with a pattern), the ULA's counters start at the top of a frame
  reset() {
    this.cpu.reset(); this.t = 0; this.ft = 0; this.frames = 0; this.ints = 0; this.waits = 0;
    this.feReads = 0; this.readingT = -1e12; this.instantT = -1;
    this.border = 7; this.out = 0; this.flash = 0; this.vt = this.cellT(0); this.cell = 0;
    this.ct = 0; this.done = 0; this.lastA = 0; this.wq = []; this.wqi = 0;
    this.cpu.intLine = false; this.fb.fill(7);
  }
  // ---- the ULA's timing ----
  delay(ft) {                                          // T-states of hold for a cycle starting at frame time ft
    if (!this.contended || ft < SPEC.CONT_T || ft >= SPEC.CONT_T + 192 * SPEC.LINE_T) return 0;
    const r = (ft - SPEC.CONT_T) % SPEC.LINE_T; return r < 128 ? SPEC.DELAY[r & 7] : 0;
  }
  static contendedAddr(a) { return (a & 0xC000) === 0x4000; }
  // The time of each access within an instruction. The processor logs each cycle just after making it, so when an
  // access starts, the cycles before it are accounted for first (catchUp): an opcode fetch takes 4 T-states, a read or
  // a write 3, an interrupt acknowledge 6, an I/O cycle what ioCycle worked out. An internal cycle leaves the last
  // address on the bus (after an opcode fetch, the refresh address: I and R), so it is held like an access to that
  // address, one T-state at a time.
  catchUp() {
    const cyc = this.cpu.cyc;
    for (; this.done < cyc.length; this.done++) {
      const c = cyc[this.done];
      if (c.k === 'ID') { c.t0 = this.ct; const h0 = this.waits; for (let k = 0; k < c.n; k++) { this.cont(this.lastA); this.ct++; } c.w = this.waits - h0; continue; }
      const q = this.wq[this.wqi++] || [0, this.ct]; c.w = q[0]; c.t0 = q[1];
      if (c.k === 'IR' || c.k === 'IW') { this.lastA = c.a; continue; }          // already timed by ioCycle
      if (c.k === 'IA') c.t0 = this.ct;
      this.ct += c.k === 'M1' ? 4 : c.k === 'IA' ? 6 : 3;
      this.lastA = c.k === 'M1' || c.k === 'IA' ? (c.rf & 0xFF00) | (c.rf & 0x80) | ((c.rf + 1) & 0x7F) : c.a;
    }
  }
  // the ULA holds the clock if the address is in 4000h-7FFFh and it is reading the screen
  cont(a) {
    if (this.log) this.log.push([this.ct, a]);
    if (SpecMachine.contendedAddr(a)) { const d = this.delay(this.ftAt(this.ct)); this.ct += d; this.waits += d; }
  }
  ftAt(ct) { return (this.ft + ct) % SPEC.FRAME_T; }
  memCycle(a) { this.catchUp(); const t0 = this.ct, h0 = this.waits; this.cont(a); this.wq.push([this.waits - h0, t0]); return this.ct; }
  // an I/O cycle (4 T-states). The ULA is selected by A0 low and holds the clock from the second T-state; an address
  // in 4000h-7FFFh is held as for memory, at each T-state if the ULA is not selected
  ioCycle(p) {
    this.catchUp(); const hi = SpecMachine.contendedAddr(p), ula = !(p & 1), t0 = this.ct, h0 = this.waits;
    const c1 = () => { if (this.log) this.log.push([this.ct, p, 'io']); const d = this.delay(this.ftAt(this.ct)); this.ct += d; this.waits += d; };
    const free = () => { };
    let at;
    if (!hi && !ula) { free(); at = this.ct + 1; this.ct += 4; }
    else if (!hi && ula) { free(); this.ct += 1; c1(); at = this.ct; this.ct += 3; }
    else if (hi && ula) { c1(); this.ct += 1; c1(); at = this.ct; this.ct += 3; }
    else { for (let k = 0; k < 4; k++) { c1(); if (k === 1) at = this.ct; this.ct += 1; } }
    this.wq.push([this.waits - h0, t0]); return at;
  }
  // ---- memory ----
  read(a) {
    this.memCycle(a);
    return a < 0x4000 ? this.rom[a] : this.ram[a - 0x4000];
  }
  write(a, v) {
    const at = this.memCycle(a);
    if (a < 0x4000) return;                            // the ROM ignores writes
    if (a < 0x5B00) this.drawTo(this.ftAt(at));         // the picture so far is drawn before the screen memory changes
    this.ram[a - 0x4000] = v;
  }
  peek(a) { a &= 0xFFFF; return a < 0x4000 ? this.rom[a] : this.ram[a - 0x4000]; }
  poke(a, v) { a &= 0xFFFF; if (a >= 0x4000) this.ram[a - 0x4000] = v & 0xFF; }
  // ---- port FE ----
  // EAR: the MIC/TAPE pin carries the outputs (bit 4 strongly, bit 3 weakly) and the tape input; bit 6 reads the
  // pin against a threshold. On issue 3 and later boards bit 4 alone reads high; on issue 2, bit 3 does too.
  earBit() { const o = this.out; return this.tapeIn() || (o & 0x10) || (this.issue < 3 && (o & 0x08)) ? 0x40 : 0; }
  keyRows(hi) { let v = 0x1F; for (let r = 0; r < 8; r++) if (!(hi & (1 << r))) v &= ~this.keys[r] & 0x1F; return v; }
  input(p) {
    const at = this.ioCycle(p);
    if (!(p & 1)) { this.feReads++; return this.keyRows(p >> 8) | 0xA0 | this.earBit(); }
    return this.floating(this.ftAt(at));
  }
  output(p, v) {
    const at = this.ioCycle(p);
    if (p & 1) return;
    this.drawTo(this.ftAt(at));
    this.border = v & 7; const was = this.out; this.out = v & 0x18;
    if ((was ^ this.out) & 0x18) this.soundEdge(at);
    if (this.rec && ((was ^ this.out) & 0x08)) this.recEdge(at);
  }
  // nothing answers an odd port: the data bus floats, and holds what the ULA is reading for the picture, if anything
  floating(ft) {
    const r = ft - (SPEC.DISP_T + 2); if (r < 0) return 0xFF;
    const line = Math.floor(r / SPEC.LINE_T), x = r % SPEC.LINE_T; if (line >= 192 || x >= 128) return 0xFF;
    const ph = x & 7; if (ph > 3) return 0xFF;
    const col = (x >> 3) * 2 + (ph >> 1);
    return ph & 1 ? this.ram[0x1800 + (line >> 3) * 32 + col] : this.ram[((line & 0xC0) << 5 | (line & 7) << 8 | (line & 0x38) << 2) + col];
  }
  // ---- the picture: 44 cells of 8 dots (4 T-states) a line, 6 of border each side of the 32 of the picture ----
  cellT(cell) { const line = SPEC.FIRST + Math.floor(cell / 44), c = cell % 44; return SPEC.DISP_T + (line - 64) * SPEC.LINE_T + (c - 6) * 4; }
  drawTo(ft) {
    const total = 44 * SPEC.FH;
    while (this.cell < total && this.vt <= ft) { this.drawCell(this.cell); this.cell++; if (this.cell < total) this.vt = this.cellT(this.cell); }
  }
  drawCell(cell) {
    const y = Math.floor(cell / 44), c = cell % 44, line = y + SPEC.FIRST - 64, o = y * SPEC.FW + c * 8, fb = this.fb;
    if (line < 0 || line >= 192 || c < 6 || c >= 38) { fb.fill(this.border, o, o + 8); return; }
    const col = c - 6, bits = this.ram[((line & 0xC0) << 5 | (line & 7) << 8 | (line & 0x38) << 2) + col], at = this.ram[0x1800 + (line >> 3) * 32 + col];
    let ink = (at & 7) | (at & 0x40) >> 3, paper = (at >> 3 & 7) | (at & 0x40) >> 3;
    if (at & 0x80 && this.flash) { const s = ink; ink = paper; paper = s; }
    for (let b = 0; b < 8; b++) fb[o + b] = bits & (0x80 >> b) ? ink : paper;
  }
  endFrame() {
    this.drawTo(SPEC.FRAME_T); this.frames++;
    if (this.feReads > 200) this.readingT = this.t;       // the keyboard takes 8 reads a frame at most: this many is a loader reading EAR
    this.feReads = 0;
    if ((this.frames & 15) === 0) this.flash ^= 1;
    this.cell = 0; this.vt = this.cellT(0);
  }
  // ---- running ----
  step() {
    this.preStep(); this.syncInt();
    return this.afterStep(this.cpu.step());
  }
  afterStep(cyc) {
    this.catchUp(); const t = this.ct;
    if (this.cpu.lastEvent === 'INT') this.ints++;
    this.tapeMove(t);
    // after an instant load the tape stops by itself once nothing has read it for 2 seconds (a custom loader keeps it going)
    if (this.tapePlay && this.instantT >= 0 && this.t - Math.max(this.instantT, this.readingT) > 2 * SPEC.CPU_HZ) { this.tapePlay = false; this.instantT = -1; }
    if (this.rec) this.rec.clock += t;
    if (this.audioRate) this.audioRun(t);
    this.t += t; this.ft += t;
    if (this.ft >= SPEC.FRAME_T) { this.ft -= SPEC.FRAME_T; this.endFrame(); this.drawTo(this.ft); }
    return t;
  }
  intOut() { return this.ft < SPEC.INT_T; }           // INT is low for the first 32 T-states of the frame
  syncInt() { this.cpu.intLine = this.intOut(); }
  // where the beam is: line of the frame and T-state in the line, and as a position in the picture kept (fb)
  beam() { const line = Math.floor(this.ft / SPEC.LINE_T), t = this.ft % SPEC.LINE_T; let x = t < 128 ? 48 + t * 2 : t < 152 ? 304 + (t - 128) * 2 : t >= 200 ? (t - 200) * 2 : -1; const y = (t >= 200 ? line + 1 : line) - SPEC.FIRST; return { line, t, x, y }; }
  // a line of the picture being drawn, and where in it: what the ULA is doing at this moment
  ulaState() {
    const ft = this.ft, line = Math.floor(ft / SPEC.LINE_T), t = ft % SPEC.LINE_T, pic = line >= 64 && line < 256;
    const what = !pic ? (line < 64 ? 'top border' : 'bottom border') : t < 128 ? 'picture, column ' + (t >> 2) : t < 152 ? 'right border' : t < 200 ? 'line blanking and sync' : 'left border';
    return { line, t, what, pic, row: pic ? line - 64 : -1 };
  }
  run(tStates) { let t = 0; while (t < tStates) t += this.step(); return t; }
  runFrame() { const f = this.frames; let t = 0; while (this.frames === f) t += this.step(); return t; }
  key(name, down) { const p = SPEC.KEYPOS[name]; if (!p) return; if (down) this.keys[p[0]] |= 1 << p[1]; else this.keys[p[0]] &= ~(1 << p[1]); }
  // ---- sound: the speaker follows bit 4 (and a little of bit 3, and the tape signal, through the MIC/TAPE pin) ----
  level() { return (this.out & 0x10 ? 0.75 : 0) + (this.out & 0x08 ? 0.1 : 0) + (this.tapePlay && this.tapeIn() ? 0.15 : 0); }
  soundEdge() { }
  audioRun(t) {
    const lv = this.level(); let left = t;
    while (left > 0) {
      const need = SPEC.CPU_HZ / this.audioRate - this.audioT, take = Math.min(left, need);
      this.lvlSum += lv * take; this.lvlN += take; this.audioT += take; left -= take;
      if (this.audioT >= SPEC.CPU_HZ / this.audioRate - 1e-9) { this.abuf[this.aw++ & 32767] = this.lvlN ? this.lvlSum / this.lvlN : 0; this.lvlSum = 0; this.lvlN = 0; this.audioT -= SPEC.CPU_HZ / this.audioRate; }
    }
  }
  // ---- cassette ----
  insertTape(bytes, name) {
    const wav = bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const file = wav ? SpecTape.fromWav(bytes, name) : bytes;
    this.tape = new SpecTape(file); this.tape.file = file; this.tape.fromWav = wav; this.tapePlay = false; this.tapeSeek(0); return this.tape;
  }
  ejectTape() { this.tape = null; this.tapePlay = false; this.tapeLevel = 0; }
  tapeSeek(seg) { const tp = this.tape; if (!tp) return; this.tapeIdx = Math.min(seg, tp.n); this.tapeRem = tp.dur[this.tapeIdx] || 0; this.tapeLevel = tp.lvl[this.tapeIdx] || 0; this.tapePos = 0; for (let q = 0; q < this.tapeIdx; q++) this.tapePos += tp.dur[q]; }
  reading() { return this.t - this.readingT < SPEC.CPU_HZ / 2; }     // has a loader been reading the tape in the last half second?
  tapeIn() { return this.tapePlay && this.tape && this.tapeIdx < this.tape.n ? this.tapeLevel : 0; }
  tapeMove(t) {
    const tp = this.tape; if (!tp || !this.tapePlay) return;
    while (t > 0) {
      if (this.tapeIdx >= tp.n) { this.tapePlay = false; this.tapeLevel = 0; return; }
      if (this.tapeRem > t) { this.tapeRem -= t; this.tapePos += t; return; }
      t -= this.tapeRem; this.tapePos += this.tapeRem; this.tapeIdx++;
      if (this.tapeIdx < tp.n) { this.tapeRem = tp.dur[this.tapeIdx]; this.tapeLevel = tp.lvl[this.tapeIdx]; }
      if (tp.stops.has(this.tapeIdx)) { this.tapePlay = false; return; }
    }
  }
  tapeBlock() { const tp = this.tape; if (!tp) return -1; let k = -1; for (let q = 0; q < tp.blocks.length && tp.blocks[q].seg <= this.tapeIdx; q++) k = q; return k; }
  // recording: the MIC output (bit 3) while REC is down, as the times between its edges
  recStart() { this.rec = { pulses: [], clock: 0, last: 0, level: (this.out >> 3) & 1 }; }
  recBusy() { return this.t - (this.recEdgeT ?? -1e12) < SPEC.CPU_HZ / 2; }     // has SAVE written to MIC in the last half second?
  recEdge(at) { const r = this.rec, l = (this.out >> 3) & 1; if (l === r.level) return; this.recEdgeT = this.t; r.level = l; r.pulses.push(r.clock + at - r.last); r.last = r.clock + at; }
  recStop() { const r = this.rec; this.rec = null; if (!r) return null; return r.pulses.length ? r.pulses : null; }
  // ---- instant loading. The ROM reads every tape block with LD-BYTES (0556h: IX address, DE length, A the flag byte,
  // carry set to load, clear to verify). When the processor is about to run it, the next block on the tape is taken from
  // the file, checked as the ROM would (flag, length, checksum), copied into RAM, the tape is wound past it, and the
  // routine returns as if it had read it: carry set if all is well. Programs with loaders of their own do not call it,
  // and still load from the signal.
  preStep() {
    if (!this.instant || !this.tape || this.rec || this.cpu.pc !== 0x0556 || this.rom[0x0556] !== 0x14) return;
    const tp = this.tape, c = this.cpu, k0 = Math.max(0, this.tapeBlock());
    let k = -1; for (let q = k0; q < tp.blocks.length; q++) { const bl = tp.blocks[q]; if (bl.data && bl.end > this.tapeIdx) { k = q; break; } }
    if (k < 0) return;
    const bl = tp.blocks[k], d = bl.data, want = c.d << 8 | c.e, load = c.f & 1;
    let ok = d[0] === c.a, x = 0, a = c.ix;
    if (ok) {
      for (const v of d) x ^= v;
      for (let i = 0; i < want && i + 1 < d.length - 1; i++, a = (a + 1) & 0xFFFF) { if (load) this.poke(a, d[i + 1]); else if (this.peek(a) !== d[i + 1]) ok = false; }
      ok = ok && x === 0 && d.length - 2 >= want;
    }
    this.tapeSeek(bl.end); this.instantLoads = (this.instantLoads || 0) + 1; this.instantT = this.t;
    c.ix = (c.ix + Math.min(want, Math.max(0, d.length - 2))) & 0xFFFF; c.d = c.e = 0;
    c.f = ok ? c.f | 1 : c.f & ~1;
    c.pc = this.peek(c.sp) | this.peek((c.sp + 1) & 0xFFFF) << 8; c.sp = (c.sp + 2) & 0xFFFF;   // RET
  }
  // ---- snapshots: .SNA (48K) and .Z80 (versions 1-3, 48K) ----
  loadSnapshot(b, name) {
    const c = this.cpu, w = i => b[i] | b[i + 1] << 8;
    if (/\.sna$/i.test(name || '') || b.length === 49179) {
      if (b.length !== 49179) throw new Error('Only 48K .SNA snapshots (49,179 bytes) can be loaded');
      c.i = b[0]; c.l_ = b[1]; c.h_ = b[2]; c.e_ = b[3]; c.d_ = b[4]; c.c_ = b[5]; c.b_ = b[6]; c.f_ = b[7]; c.a_ = b[8];
      c.l = b[9]; c.h = b[10]; c.e = b[11]; c.d = b[12]; c.c = b[13]; c.b = b[14]; c.iy = w(15); c.ix = w(17);
      c.iff1 = c.iff2 = b[19] & 4 ? 1 : 0; c.r = b[20]; c.f = b[21]; c.a = b[22]; c.sp = w(23); c.im = b[25] & 3; this.border = b[26] & 7;
      this.ram.set(b.subarray(27, 27 + 0xC000)); c.halted = false;
      c.pc = this.peek(c.sp) | this.peek(c.sp + 1) << 8; c.sp = (c.sp + 2) & 0xFFFF;     // RETN
      return 'SNA';
    }
    // .Z80
    c.a = b[0]; c.f = b[1]; c.c = b[2]; c.b = b[3]; c.l = b[4]; c.h = b[5]; let pc = w(6); c.sp = w(8); c.i = b[10];
    const f12 = b[12] === 255 ? 1 : b[12]; c.r = (b[11] & 0x7F) | (f12 & 1) << 7; this.border = f12 >> 1 & 7;
    c.e = b[13]; c.d = b[14]; c.c_ = b[15]; c.b_ = b[16]; c.e_ = b[17]; c.d_ = b[18]; c.l_ = b[19]; c.h_ = b[20]; c.a_ = b[21]; c.f_ = b[22];
    c.iy = w(23); c.ix = w(25); c.iff1 = b[27] ? 1 : 0; c.iff2 = b[28] ? 1 : 0; c.im = b[29] & 3; c.halted = false;
    const unpack = (src, from, to, out, outOff, outLen) => {
      let i = from, o = outOff; const end = outOff + outLen;
      while (i < to && o < end) {
        if (src[i] === 0xED && src[i + 1] === 0xED) { const n = src[i + 2], v = src[i + 3]; for (let k = 0; k < n && o < end; k++) out[o++] = v; i += 4; }
        else out[o++] = src[i++];
      }
      return o - outOff;
    };
    if (pc) {                                           // version 1: 48K, compressed if bit 5 of byte 12
      if (f12 & 0x20) unpack(b, 30, b.length, this.ram, 0, 0xC000); else this.ram.set(b.subarray(30, 30 + 0xC000));
      c.pc = pc; return 'Z80 v1';
    }
    const hl = w(30), hw = b[34]; pc = w(32); const v = hl === 23 ? 2 : 3;
    if ((v === 2 && hw > 2) || (v === 3 && hw > 3)) throw new Error('This .Z80 snapshot is not for a 48K Spectrum');
    let i = 32 + hl;
    const pages = { 8: 0x0000, 4: 0x4000, 5: 0x8000 };      // page 8: 4000h, 4: 8000h, 5: C000h (as offsets into the RAM)
    while (i + 3 <= b.length) {
      const len = w(i), page = b[i + 2]; i += 3;
      const at = pages[page]; const n = len === 0xFFFF ? 0x4000 : len;
      if (at !== undefined) { if (len === 0xFFFF) this.ram.set(b.subarray(i, i + 0x4000), at); else unpack(b, i, i + n, this.ram, at, 0x4000); }
      i += n;
    }
    c.pc = pc; return 'Z80 v' + v;
  }
  // a 48K .SNA of the machine now (PC pushed on the stack, as the format wants)
  saveSnapshot() {
    const c = this.cpu, b = new Uint8Array(49179), sp = (c.sp - 2) & 0xFFFF;
    const ram = this.ram.slice(); if (sp >= 0x4000) { ram[sp - 0x4000] = c.pc & 0xFF; } if (sp + 1 >= 0x4000 && sp + 1 <= 0xFFFF) ram[sp + 1 - 0x4000] = c.pc >> 8;
    b.set([c.i, c.l_, c.h_, c.e_, c.d_, c.c_, c.b_, c.f_, c.a_, c.l, c.h, c.e, c.d, c.c, c.b, c.iy & 255, c.iy >> 8, c.ix & 255, c.ix >> 8, c.iff2 ? 4 : 0, c.r, c.f, c.a, sp & 255, sp >> 8, c.im, this.border]);
    b.set(ram, 27); return b;
  }
  // ---- the screen as text, through the ROM's character set (3D00h, space to the copyright sign) ----
  screenText() {
    const font = {}; for (let ch = 32; ch < 128; ch++) font[[...this.rom.subarray(0x3D00 + (ch - 32) * 8, 0x3D08 + (ch - 32) * 8)].join()] = ch;
    const out = [];
    for (let row = 0; row < 24; row++) {
      let s = '';
      for (let col = 0; col < 32; col++) {
        const pat = []; for (let y = 0; y < 8; y++) { const line = row * 8 + y; pat.push(this.ram[((line & 0xC0) << 5 | (line & 7) << 8 | (line & 0x38) << 2) + col]); }
        let ch = font[pat.join()]; if (ch === undefined) ch = font[pat.map(v => v ^ 255).join()];
        s += ch === undefined ? '?' : ch === 127 ? '(c)' : String.fromCharCode(ch);
      }
      out.push(s.replace(/\s+$/, ''));
    }
    return out;
  }
}
if (typeof module !== 'undefined') module.exports = { SpecMachine, SpecTape, SPEC, specCrc32 };
