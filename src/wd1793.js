// Western Digital FD179x floppy disk controller, with a floppy disk and ImageDisk (.IMD) files.
// The Osborne Executive's main board has an FD1793 (UB17): true data bus, no side-select output, clocked at 1 MHz
// for 5.25-inch drives, so every time in the data sheet (which assumes 2 MHz) doubles.
// The model works in CPU T-states: the machine calls advance(t) as time passes. A disk turns once in 200 ms while
// its drive is selected (the Executive's motor runs whenever a drive is selected). Sectors sit at even intervals
// round the track, and a command waits for the right piece of track to come under the head, so reading a sector
// takes as long as it would on the real drive and data bytes arrive at the real rate (32 us in double density,
// 64 us in single). If the program does not take a byte before the next one arrives, the Lost Data bit is set, as
// on the chip.
//
// Commands: Restore, Seek, Step, Step-in, Step-out (type I, with the verify flag); Read Sector and Write Sector
// (type II, with the multiple-record flag); Read Address and Write Track (type III); Force Interrupt (type IV).
// Read Track is not implemented: it ends at once with Record Not Found.
// With no disk in the selected drive there are no index pulses, so a command that needs the disk stays busy until
// the program gives up and sends Force Interrupt, which is what happens on the Executive (its READY input is tied high).
// Pin faults: the machine puts the level of any faulty pin in pf (pin -> 0 or 1; a disconnected input reads 1).
//   CLK: no clock, so a command never moves on (the disk still turns); STEP: the head never moves; DIR: the head
//   always steps one way (high = in); TR00, INDEX, WPRT, RDY: the chip sees that level whatever the drive says
//   (INDEX at either level gives no index edges, so nothing times out); RAWRD or RDCLK: no data comes off the disk, so
//   no ID field is ever found; WG or WD: writes never reach the disk.

// ---------- a floppy disk: tracks[cylinder][head] = { mfm, rate, sectors: [{ c, h, r, n, data, deleted, crcErr }] } ----------
class FloppyDisk {
  constructor(name) { this.name = name || 'disk'; this.tracks = []; this.comment = ''; this.writeProtected = false; this.dirty = false; }
  track(cyl, head) { const t = this.tracks[cyl]; return (t && t[head]) || null; }
  setTrack(cyl, head, trk) { (this.tracks[cyl] = this.tracks[cyl] || [])[head] = trk; }
  get cylinders() { return this.tracks.length; }
  get heads() { let h = 0; for (const t of this.tracks) if (t) h = Math.max(h, t.length); return h; }
  // a short description: "40 tracks, 1 side, 5 x 1024 bytes, double density"
  describe() {
    const kinds = new Map(); let bytes = 0;
    for (const t of this.tracks) if (t) for (const tr of t) if (tr && tr.sectors.length) {
      const k = `${tr.sectors.length} × ${tr.sectors[0].data.length} bytes, ${tr.mfm ? 'double' : 'single'} density`; kinds.set(k, (kinds.get(k) || 0) + 1);
      for (const s of tr.sectors) bytes += s.data.length;
    }
    const main = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
    return `${this.cylinders} tracks, ${this.heads} side${this.heads === 1 ? '' : 's'}, ${main.length ? main[0] + (main.length > 1 ? ' (and ' + (main.length - 1) + ' other format' + (main.length > 2 ? 's' : '') + ')' : '') : 'unformatted'}, ${Math.round(bytes / 1024)}K`;
  }
}

// ---------- ImageDisk (.IMD) files ----------
// Header "IMD v.vv: date time", a comment and a 1Ah byte; then for each track: mode (0-2 FM at 500, 300, 250 kbps;
// 3-5 MFM), cylinder, head (bit 7: a cylinder number follows for each sector, bit 6: a head number), sector count,
// size code (128 << n; FFh: a 16-bit size follows for each sector), the sector numbers, the optional maps, and for
// each sector a type byte: 0 no data, odd = the data follows, even = one byte that fills the sector; 3-4 deleted
// data mark, 5-8 read with a CRC error.
const IMD_RATE = [500, 300, 250, 500, 300, 250];
function parseIMD(bytes, name) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!(b[0] === 0x49 && b[1] === 0x4D && b[2] === 0x44 && b[3] === 0x20)) throw new Error('not an ImageDisk file: it does not start with "IMD "');
  let p = b.indexOf(0x1A); if (p < 0) throw new Error('ImageDisk file has no end-of-comment mark');
  let head = ''; for (let i = 0; i < p; i++) head += String.fromCharCode(b[i]);
  const nl = head.indexOf('\n'), disk = new FloppyDisk(name);
  disk.header = (nl < 0 ? head : head.slice(0, nl)).trim(); disk.comment = nl < 0 ? '' : head.slice(nl + 1).replace(/\r/g, '').trim();
  p++;
  while (p < b.length) {
    if (p + 5 > b.length) throw new Error('ImageDisk file is cut short in a track header');
    const mode = b[p], cyl = b[p + 1], hb = b[p + 2], n = b[p + 3], sc = b[p + 4]; p += 5;
    if (mode > 5) throw new Error(`ImageDisk track ${cyl}: unknown mode ${mode}`);
    const hd = hb & 1, nums = b.subarray(p, p + n); p += n;
    const cmap = hb & 0x80 ? b.subarray(p, p + n) : null; if (cmap) p += n;
    const hmap = hb & 0x40 ? b.subarray(p, p + n) : null; if (hmap) p += n;
    const sizes = []; if (sc === 0xFF) { for (let i = 0; i < n; i++) sizes.push(b[p + 2 * i] | b[p + 2 * i + 1] << 8); p += 2 * n; } else { if (sc > 6) throw new Error(`ImageDisk track ${cyl}: unknown sector size code ${sc}`); for (let i = 0; i < n; i++) sizes.push(128 << sc); }
    const trk = { mfm: mode >= 3, rate: IMD_RATE[mode], sectors: [] };
    for (let i = 0; i < n; i++) {
      if (p >= b.length) throw new Error(`ImageDisk file is cut short in track ${cyl}`);
      const ty = b[p++], size = sizes[i]; let ncode = 0; while ((128 << ncode) < size && ncode < 7) ncode++;
      const s = { c: cmap ? cmap[i] : cyl, h: hmap ? hmap[i] : hd, r: nums[i], n: ncode, data: new Uint8Array(size), deleted: false, crcErr: false, noData: false };
      if (ty === 0) s.noData = true;
      else if (ty > 8) throw new Error(`ImageDisk track ${cyl}: unknown sector record type ${ty}`);
      else {
        if (ty & 1) { if (p + size > b.length) throw new Error(`ImageDisk file is cut short in track ${cyl}`); s.data.set(b.subarray(p, p + size)); p += size; } else s.data.fill(b[p++]);
        s.deleted = ty === 3 || ty === 4 || ty === 7 || ty === 8; s.crcErr = ty >= 5;
      }
      trk.sectors.push(s);
    }
    disk.setTrack(cyl, hd, trk);
  }
  for (let c = 0; c < disk.tracks.length; c++) if (!disk.tracks[c]) disk.tracks[c] = [];
  return disk;
}
// ---------- Teledisk (.TD0) files ----------
// A 12-byte header: "TD" (plain) or "td" (everything after the header compressed with LZHUF), volume sequence, check
// signature, version, data rate (bits 0-1: 250, 300 or 500 kbps; bit 7: single density, FM), drive type, stepping
// (bit 7: a comment block follows), DOS allocation flag, sides, CRC. The comment block: CRC, text length, date and
// time (6 bytes), then the text (lines ending in 00h). Then each track: sector count (FFh ends the disk), cylinder,
// head (bit 7: this track is FM), CRC; and for each sector: cylinder, head, sector number, size code, flags (02h CRC
// error, 04h deleted data mark, 10h or 20h no data), CRC; then, unless there is no data, a data block: its length
// (2 bytes, counting the next byte), the encoding (0 raw, 1 a 2-byte pattern repeated a 2-byte count of times, 2 runs:
// 00h n = n literal bytes, k r = a pattern of 2^k bytes repeated r times), and the encoded bytes.
// LZHUF is Okumura and Yoshizaki's 1988 compressor: a 4K window, matches of 3 to 60 bytes, and adaptive Huffman codes.
function td0Unpack(src) {
  const N = 4096, F = 60, TH = 2, NC = 256 - TH + F, T = NC * 2 - 1, R = T - 1, MAX = 0x8000;
  const freq = new Uint32Array(T + 1), prnt = new Int32Array(T + NC), son = new Int32Array(T), buf = new Uint8Array(N).fill(0x20);
  const dCode = [], dLen = [];
  for (const [code0, n, each, len] of [[0, 1, 32, 3], [1, 3, 16, 4], [4, 8, 8, 5], [12, 12, 4, 6], [24, 24, 2, 7], [48, 16, 1, 8]])
    for (let c = 0; c < n; c++) for (let k = 0; k < each; k++) { dCode.push(code0 + c); dLen.push(len); }
  for (let i = 0; i < NC; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = NC; j <= R; i += 2, j++) { freq[j] = freq[i] + freq[i + 1]; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xFFFF; prnt[R] = 0;
  let pos = 0, bitBuf = 0, bitLen = 0;
  const bit = () => { if (!bitLen) { bitBuf = pos < src.length ? src[pos++] : 0; bitLen = 8; } bitLen--; return bitBuf >> bitLen & 1; };
  const byte = () => { let v = 0; for (let k = 0; k < 8; k++) v = v << 1 | bit(); return v; };
  const reconst = () => {
    let j = 0;
    for (let i = 0; i < T; i++) if (son[i] >= T) { freq[j] = (freq[i] + 1) >> 1; son[j] = son[i]; j++; }
    for (let i = 0, j2 = NC; j2 < T; i += 2, j2++) {
      const f = freq[j2] = freq[i] + freq[i + 1]; let k = j2 - 1; while (f < freq[k]) k--; k++;
      freq.copyWithin(k + 1, k, j2); freq[k] = f; son.copyWithin(k + 1, k, j2); son[k] = i;
    }
    for (let i = 0; i < T; i++) { const k = son[i]; if (k >= T) prnt[k] = i; else prnt[k] = prnt[k + 1] = i; }
  };
  const update = c0 => {
    if (freq[R] === MAX) reconst();
    let c = prnt[c0 + T];
    do {
      const k = ++freq[c]; let l = c + 1;
      if (k > freq[l]) {
        while (k > freq[++l]); l--;
        freq[c] = freq[l]; freq[l] = k;
        const i = son[c]; prnt[i] = l; if (i < T) prnt[i + 1] = l;
        const j = son[l]; son[l] = i; prnt[j] = c; if (j < T) prnt[j + 1] = c; son[c] = j;
        c = l;
      }
    } while ((c = prnt[c]) !== 0);
  };
  const decChar = () => { let c = son[R]; while (c < T) c = son[c + bit()]; c -= T; update(c); return c; };
  const decPos = () => { let i = byte(); const c = dCode[i] << 6; let j = dLen[i] - 2; while (j-- > 0) i = (i << 1) + bit(); return c | (i & 0x3F); };
  const out = []; let r = N - F;
  while (pos < src.length || bitLen) {
    const c = decChar();
    if (c < 256) { out.push(c); buf[r++] = c; r &= N - 1; }
    else { const i = (r - decPos() - 1) & (N - 1), len = c - 255 + TH; for (let k = 0; k < len; k++) { const v = buf[(i + k) & (N - 1)]; out.push(v); buf[r++] = v; r &= N - 1; } }
    if (pos >= src.length && bitLen === 0) break;
  }
  return new Uint8Array(out);
}
function parseTD0(bytes, name) {
  const h = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = String.fromCharCode(h[0], h[1]);
  if (h.length < 12 || (sig !== 'TD' && sig !== 'td')) throw new Error('not a Teledisk file: it does not start with "TD" or "td"');
  if (sig === 'td' && h[4] < 20) throw new Error(`Teledisk ${h[4] / 10} files with advanced compression (the old LZW kind) are not supported`);
  const b = sig === 'td' ? new Uint8Array([...h.subarray(0, 12), ...td0Unpack(h.subarray(12))]) : h;
  const rateFM = !!(b[5] & 0x80), rate = [250, 300, 500][b[5] & 3] || 250, disk = new FloppyDisk(name);
  disk.header = `Teledisk ${Math.floor(b[4] / 10)}.${b[4] % 10}${sig === 'td' ? ', advanced compression' : ''}`;
  let p = 12;
  if (b[7] & 0x80) {
    if (p + 10 > b.length) throw new Error('Teledisk file is cut short in its comment');
    const len = b[p + 2] | b[p + 3] << 8, d = b.subarray(p + 4, p + 10);
    // the text is in the PC's code page 437: keep the accented letters it is most likely to hold
    const cp437 = { 0x81: 'ü', 0x82: 'é', 0x83: 'â', 0x84: 'ä', 0x85: 'à', 0x87: 'ç', 0x88: 'ê', 0x89: 'ë', 0x8A: 'è', 0x8E: 'Ä', 0x90: 'É', 0x94: 'ö', 0x99: 'Ö', 0x9A: 'Ü', 0xA0: 'á', 0xA1: 'í', 0xA2: 'ó', 0xA3: 'ú', 0xA4: 'ñ', 0xE1: 'ß' };
    disk.comment = Array.from(b.subarray(p + 10, p + 10 + len), c => c === 0 ? '\n' : c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : cp437[c] || '').join('').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
    disk.date = `${1900 + d[0]}-${String(d[1] + 1).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
    p += 10 + len;
  }
  for (;;) {
    if (p >= b.length) throw new Error('Teledisk file is cut short: no end-of-disk mark');
    const n = b[p]; if (n === 0xFF) break;
    if (p + 4 > b.length) throw new Error('Teledisk file is cut short in a track header');
    const cyl = b[p + 1], hd = b[p + 2] & 1, fm = rateFM || !!(b[p + 2] & 0x80); p += 4;
    const trk = { mfm: !fm, rate, sectors: [] };
    for (let i = 0; i < n; i++) {
      if (p + 6 > b.length) throw new Error(`Teledisk file is cut short in track ${cyl}`);
      const [c, hh, r, nc, fl] = b.subarray(p, p + 5), size = 128 << Math.min(nc, 6); p += 6;
      const s = { c, h: hh, r, n: nc, data: new Uint8Array(size), deleted: !!(fl & 0x04), crcErr: !!(fl & 0x02), noData: !!(fl & 0x30) };
      if (!s.noData) {
        const blen = b[p] | b[p + 1] << 8, enc = b[p + 2], end = p + 2 + blen; let q = p + 3, o = 0;
        if (end > b.length) throw new Error(`Teledisk file is cut short in track ${cyl}, sector ${r}`);
        if (enc === 0) { s.data.set(b.subarray(q, q + Math.min(size, end - q))); }
        else if (enc === 1) { while (q + 4 <= end && o < size) { const cnt = b[q] | b[q + 1] << 8; for (let k = 0; k < cnt && o < size; k++) { s.data[o++] = b[q + 2]; if (o < size) s.data[o++] = b[q + 3]; } q += 4; } }
        else if (enc === 2) {
          while (q < end && o < size) {
            const k = b[q++];
            if (k === 0) { const m = b[q++]; for (let t = 0; t < m && o < size; t++) s.data[o++] = b[q + t]; q += m; }
            else { const plen = 1 << k, rep = b[q++]; for (let t = 0; t < rep; t++) for (let u = 0; u < plen && o < size; u++) s.data[o++] = b[q + u]; q += plen; }
          }
        } else throw new Error(`Teledisk track ${cyl}, sector ${r}: unknown data encoding ${enc}`);
        p = end;
      }
      trk.sectors.push(s);
    }
    disk.setTrack(cyl, hd, trk);
  }
  for (let c = 0; c < disk.tracks.length; c++) if (!disk.tracks[c]) disk.tracks[c] = [];
  return disk;
}
// a disk image of either kind, told apart by its first bytes
function parseDiskImage(bytes, name) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), s = String.fromCharCode(b[0], b[1]);
  return s === 'TD' || s === 'td' ? parseTD0(b, name) : parseIMD(b, name);
}
function writeIMD(disk, stamp) {
  const out = [], put = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF); };
  const d = stamp || new Date(), z = v => String(v).padStart(2, '0');
  put(`IMD 1.18: ${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}\r\n`);
  put((disk.comment || '').replace(/\r?\n/g, '\r\n')); out.push(0x1A);
  for (let c = 0; c < disk.tracks.length; c++) for (let h = 0; h < (disk.tracks[c] || []).length; h++) {
    const t = disk.tracks[c][h]; if (!t || !t.sectors.length) continue;
    const n = t.sectors.length, mode = (t.mfm ? 3 : 0) + Math.max(0, IMD_RATE.indexOf(t.rate));
    const same = t.sectors.every(s => s.data.length === t.sectors[0].data.length && s.data.length === 128 << s.n), cm = t.sectors.some(s => s.c !== c), hm = t.sectors.some(s => s.h !== h);
    out.push(mode, c, h | (cm ? 0x80 : 0) | (hm ? 0x40 : 0), n, same ? t.sectors[0].n : 0xFF);
    for (const s of t.sectors) out.push(s.r);
    if (cm) for (const s of t.sectors) out.push(s.c);
    if (hm) for (const s of t.sectors) out.push(s.h);
    if (!same) for (const s of t.sectors) out.push(s.data.length & 0xFF, s.data.length >> 8);
    for (const s of t.sectors) {
      if (s.noData) { out.push(0); continue; }
      const fill = s.data.every(v => v === s.data[0]), ty = 1 + (s.deleted ? 2 : 0) + (s.crcErr ? 4 : 0);
      if (fill) out.push(ty + 1, s.data[0]); else { out.push(ty); for (const v of s.data) out.push(v); }
    }
  }
  return new Uint8Array(out);
}

// CRC-CCITT as the 179x computes it (preset to FFFFh, most significant bit first)
function fdcCrc(bytes, crc) {
  crc = crc === undefined ? 0xFFFF : crc;
  for (const v of bytes) { crc ^= v << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1; crc &= 0xFFFF; }
  return crc;
}

// ---------- the controller ----------
const FDC = { BUSY: 0x01, DRQ: 0x02, INDEX: 0x02, LOST: 0x04, TR00: 0x04, CRC: 0x08, RNF: 0x10, SEEKERR: 0x10, RECTYPE: 0x20, HEADLOADED: 0x20, WP: 0x40, NOTREADY: 0x80 };
class WD1793 {
  // cpuHz: T-states per second; opts.clock: 1 or 2 (MHz at the CLK pin); opts.maxCyl: the drive's last cylinder
  constructor(cpuHz, opts) {
    opts = opts || {};
    this.cpuHz = cpuHz; this.slow = (opts.clock || 1) === 1 ? 2 : 1;      // 1 MHz clock: all the chip's times double
    this.ms = cpuHz / 1000;
    this.revT = Math.round(cpuHz * 0.2);                                    // 300 rpm
    this.indexT = Math.round(cpuHz * 0.004);                                // the index pulse lasts about 4 ms
    this.maxCyl = opts.maxCyl || 42;
    this.drive = null;                    // the selected drive: { disk, cyl }, or null
    this.dden = true;                     // the DDEN* pin is low: double density (MFM)
    this.onIntrq = () => {};
    this.pf = {};                         // levels of faulty pins (see above)
    this.rot = 0; this.revs = 0;          // position within the revolution, in T-states; revolutions counted while a command waits
    this.reset();
  }
  reset() {
    this.status = 0; this.track = 0; this.sector = 0; this.data = 0; this.cmd = 0xD0;
    this.type = 1; this.busy = false; this.drq = false; this.intrq = false; this.dir = 1; this.hld = false;
    this.phase = null; this.wait = 0; this.flags = 0; this.buf = null; this.pos = 0; this.cur = null; this.lastCmd = 'reset';
    this.onIntrq(0);
    // MR* runs a Restore at the slowest step rate
    this.command(0x03);
  }
  // ----- the disk under the head -----
  get disk() { return this.drive ? this.drive.disk : null; }
  trk() { const d = this.disk; return d ? d.track(this.drive.cyl, 0) : null; }
  // the IDs the controller can read on this track: none unless the track's encoding matches the DDEN* pin
  ids() { const t = this.trk(), f = this.pf; return t && t.mfm === this.dden && !('RAWRD' in f) && !('RDCLK' in f) ? t.sectors : []; }
  // what the chip sees on its drive inputs, faults included
  tr0() { return 'TR00' in this.pf ? this.pf.TR00 === 0 : !!this.drive && this.drive.cyl === 0; }
  wp() { return 'WPRT' in this.pf ? this.pf.WPRT === 0 : !!this.disk && this.disk.writeProtected; }
  ready() { return this.pf.RDY !== 0; }
  noIndex() { return 'INDEX' in this.pf; }
  canWrite() { return !('WG' in this.pf) && !('WD' in this.pf); }
  byteT(t) { const tr = t || this.trk(), rate = tr ? tr.rate : 250; return this.cpuHz * (this.dden ? 8 : 16) / (rate * 1000); }
  // T-states until sector index i's ID field comes round (sectors are spaced evenly after the index)
  toSector(i, n) { const at = this.indexT + (this.revT - this.indexT) * i / n; let d = at - this.rot; if (d < 0) d += this.revT; return d; }
  indexPin() { return 'INDEX' in this.pf ? this.pf.INDEX === 0 : !!this.disk && this.rot < this.indexT; }
  // ----- registers -----
  read(reg) {
    switch (reg & 3) {
      case 0: { if (this.intrq) { this.intrq = false; this.onIntrq(0); } return this.statusByte(); }
      case 1: return this.track;
      case 2: return this.sector;
      default: this.drq = false; return this.data;
    }
  }
  statusByte() {
    let s = this.status & ~(FDC.BUSY | FDC.DRQ | FDC.NOTREADY | FDC.WP);      // READY is tied high on the Executive
    if (this.busy) s |= FDC.BUSY;
    if (!this.ready()) s |= FDC.NOTREADY;
    if (this.type === 1) {
      s &= ~(FDC.INDEX | FDC.TR00 | FDC.HEADLOADED);
      if (this.indexPin()) s |= FDC.INDEX;
      if (this.tr0()) s |= FDC.TR00;
      if (this.hld) s |= FDC.HEADLOADED;
      if (this.wp()) s |= FDC.WP;
    } else { if (this.drq) s |= FDC.DRQ; s |= this.status & FDC.WP; }
    return s & 0xFF;
  }
  write(reg, v) {
    v &= 0xFF;
    switch (reg & 3) {
      case 0: this.command(v); break;
      case 1: this.track = v; break;
      case 2: this.sector = v; break;
      default: this.data = v; this.drq = false;
    }
  }
  command(v) {
    if ((v & 0xF0) === 0xD0) {            // Force Interrupt
      const was = this.busy;
      this.busy = false; this.drq = false; this.phase = null; this.lastCmd = 'Force Interrupt';
      if (!was) { this.type = 1; this.status = 0; }
      if (this.intrq && !(v & 0x08)) { this.intrq = false; this.onIntrq(0); }
      if (v & 0x08) { this.intrq = true; this.onIntrq(1); }
      this.cmd = v; return;
    }
    if (this.busy) return;                // a command written while busy is ignored
    if (this.intrq) { this.intrq = false; this.onIntrq(0); }
    this.cmd = v; this.busy = true; this.drq = false; this.revs = 0;
    if (!(v & 0x80)) {                    // ----- type I -----
      this.type = 1; this.status = 0; this.hld = !!(v & 0x08);
      this.stepT = [6, 12, 20, 30][v & 3] * this.slow * this.ms;
      if (!(v & 0xF0)) { this.lastCmd = 'Restore'; this.track = 0xFF; this.data = 0; this.dir = -1; this.left = 255; this.phase = 'restore'; }
      else if ((v & 0xF0) === 0x10) { this.lastCmd = 'Seek'; this.phase = 'seek'; }
      else { this.lastCmd = (v & 0xE0) === 0x20 ? 'Step' : (v & 0xE0) === 0x40 ? 'Step in' : 'Step out'; if ((v & 0xE0) === 0x40) this.dir = 1; else if ((v & 0xE0) === 0x60) this.dir = -1; this.phase = 'step1'; }
      this.wait = 24;                     // a few clock periods before anything happens
      return;
    }
    this.type = 2; this.status = 0; this.hld = true;
    if (!this.ready()) { this.lastCmd = 'not ready'; this.busy = false; this.intrq = true; this.onIntrq(1); return; }      // READY low: type II and III commands are not run
    const settle = v & 0x04 ? 15 * this.slow * this.ms : 24;
    switch (v & 0xE0) {
      case 0x80: this.lastCmd = 'Read Sector'; this.phase = 'find'; this.wait = settle; break;
      case 0xA0: this.lastCmd = 'Write Sector'; this.phase = 'find'; this.wait = settle; break;
      case 0xC0: this.lastCmd = 'Read Address'; this.phase = 'addr'; this.wait = settle; break;
      default:
        if (v & 0x10) { this.lastCmd = 'Write Track'; this.phase = 'wtwait'; this.wait = settle; }
        else { this.lastCmd = 'Read Track (not implemented)'; this.status = FDC.RNF; this.phase = 'done'; this.wait = settle; }
    }
  }
  // ----- time -----
  advance(t) {
    if (this.drive) { this.rot += t; while (this.rot >= this.revT) { this.rot -= this.revT; if (this.disk) this.revs++; } }
    if (!this.phase || 'CLK' in this.pf) return;
    this.wait -= t;
    while (this.phase && this.wait <= 0) this.tick();
  }
  finish(bits) {
    if (bits) this.status |= bits;
    this.busy = false; this.drq = false; this.phase = null; this.intrq = true; this.onIntrq(1);
  }
  stepHead(dir) { const d = this.drive, f = this.pf; if ('DIR' in f) dir = f.DIR ? 1 : -1; if (d && !('STEP' in f)) d.cyl = Math.max(0, Math.min(this.maxCyl, d.cyl + dir)); }
  // a missing ID: Record Not Found after five index pulses, or never without index edges
  notFound(bits) { if (this.noIndex()) { this.wait = Infinity; return; } this.phase = 'fail'; this.fail = bits; this.wait += 5 * this.revT; }
  tick() {
    const c = this.cmd;
    switch (this.phase) {
      // ----- type I -----
      case 'restore':
        if (this.tr0()) { this.track = 0; this.phase = 'verify'; break; }
        if (this.left-- <= 0) { this.track = 0; this.finish(FDC.SEEKERR); break; }      // 255 steps and TR00* never came (no drive selected)
        this.stepHead(-1); this.wait += this.stepT; break;
      case 'seek':
        if (this.track === this.data) { this.phase = 'verify'; break; }
        this.dir = this.data > this.track ? 1 : -1; this.track = (this.track + this.dir) & 0xFF; this.stepHead(this.dir);
        this.wait += this.stepT; break;
      case 'step1':
        if (c & 0x10) this.track = (this.track + this.dir) & 0xFF;
        if (!(this.dir < 0 && this.tr0())) this.stepHead(this.dir); else if (c & 0x10) this.track = 0;
        this.phase = 'verify'; this.wait += this.stepT; break;
      case 'verify':
        if (!(c & 0x04)) { this.finish(0); break; }
        this.phase = 'verify2'; this.wait += 15 * this.slow * this.ms; this.revs = 0; break;
      case 'verify2': {                   // read an ID and compare its track number with the track register
        if (!this.disk) { this.wait = Infinity; break; }                    // no index pulses: the chip waits for ever
        const ids = this.ids(), hit = ids.find(s => s.c === this.track);
        if (hit) { this.wait += this.toSector(ids.indexOf(hit), ids.length) + 10 * this.byteT(); this.phase = 'done'; break; }
        this.notFound(FDC.SEEKERR); break;
      }
      // ----- type II: find the sector -----
      case 'find': {
        if (!this.disk) { this.wait = Infinity; break; }
        if ((c & 0xE0) === 0xA0 && this.wp()) { this.finish(FDC.WP); break; }
        const ids = this.ids(), i = ids.findIndex(s => s.c === this.track && s.r === this.sector && !s.noData);
        if (i < 0) { this.notFound(FDC.RNF); break; }
        this.cur = ids[i]; const bt = this.byteT();
        // the ID field, then the gap: the data mark follows about 40 bytes later in double density, 28 in single
        this.wait += this.toSector(i, ids.length) + (this.dden ? 10 + 43 : 7 + 28) * bt;
        if ((c & 0xE0) === 0x80) { this.pos = 0; this.phase = 'rd'; if (this.cur.deleted) this.status |= FDC.RECTYPE; }
        else { this.phase = 'wrdrq'; this.wait -= (this.dden ? 22 : 11) * bt; }
        break;
      }
      case 'rd': {
        const s = this.cur;
        if (this.pos >= s.data.length) { this.phase = 'rdend'; this.wait += 2 * this.byteT(); break; }
        if (this.drq) this.status |= FDC.LOST;
        this.data = s.data[this.pos++]; this.drq = true; this.wait += this.byteT(); break;
      }
      case 'rdend':
        if (this.drq) this.status |= FDC.LOST;
        if (this.cur.crcErr) { this.finish(FDC.CRC); break; }
        if (c & 0x10) { this.sector = (this.sector + 1) & 0xFF; this.phase = 'find'; this.wait += this.byteT(); break; }      // multiple records: on to the next sector
        this.finish(0); break;
      // ----- write sector -----
      case 'wrdrq': this.drq = true; this.phase = 'wrgo'; this.wait += (this.dden ? 22 : 11) * this.byteT(); break;
      case 'wrgo':
        if (this.drq) { this.finish(FDC.LOST); break; }                    // the first byte never came: nothing is written
        this.pos = 0; this.phase = 'wr'; this.wait += (this.dden ? 13 : 7) * this.byteT(); break;      // sync bytes and the data mark
      case 'wr': {
        const s = this.cur;
        if (this.drq) { this.status |= FDC.LOST; this.data = 0; this.drq = false; }      // a byte that was not supplied is written as zero
        if (this.canWrite()) { s.data[this.pos] = this.data; this.disk.dirty = true; } this.pos++;
        if (this.pos >= s.data.length) { if (this.canWrite()) { s.deleted = !!(c & 1); s.crcErr = false; } this.phase = 'wrend'; this.wait += 3 * this.byteT(); break; }
        this.drq = true; this.wait += this.byteT(); break;
      }
      case 'wrend':
        if (c & 0x10) { this.sector = (this.sector + 1) & 0xFF; this.phase = 'find'; this.wait += this.byteT(); break; }
        this.finish(0); break;
      // ----- read address: the next ID field to come round -----
      case 'addr': {
        if (!this.disk) { this.wait = Infinity; break; }
        const ids = this.ids();
        if (!ids.length) { this.notFound(FDC.RNF); break; }
        let best = 0, bd = Infinity; ids.forEach((s, i) => { const d = this.toSector(i, ids.length); if (d < bd) { bd = d; best = i; } });
        const s = ids[best], id = [s.c, s.h, s.r, s.n], crc = fdcCrc(this.dden ? [0xA1, 0xA1, 0xA1, 0xFE, ...id] : [0xFE, ...id]);
        this.buf = [...id, crc >> 8, crc & 0xFF]; this.pos = 0; this.sector = s.c;      // the chip copies the track address into the sector register
        this.phase = 'addrrd'; this.wait += bd + (this.dden ? 4 : 1) * this.byteT(); break;
      }
      case 'addrrd':
        if (this.pos >= 6) { this.finish(0); break; }
        if (this.drq) this.status |= FDC.LOST;
        this.data = this.buf[this.pos++]; this.drq = true; this.wait += this.byteT(); break;
      // ----- write track (format) -----
      case 'wtwait': {
        if (!this.disk) { this.wait = Infinity; break; }
        if (this.wp()) { this.finish(FDC.WP); break; }
        if (this.noIndex()) { this.wait = Infinity; break; }                // writing waits for an index pulse that never comes
        this.drq = true; this.phase = 'wtindex'; this.wait += 3 * this.byteT(); break;
      }
      case 'wtindex':
        if (this.drq) { this.finish(FDC.LOST); break; }                    // no first byte within three byte times
        this.buf = []; this.wtLen = Math.floor(this.revT / this.byteT());
        this.phase = 'wt'; this.wait += this.revT - this.rot; break;       // writing starts at the leading edge of the index pulse
      case 'wt':
        if (this.drq) { this.status |= FDC.LOST; this.data = 0; }
        this.buf.push(this.data);
        if (this.buf.length >= this.wtLen) { this.drq = false; if (this.canWrite()) this.formatTrack(this.buf); this.finish(0); break; }
        this.drq = true; this.wait += this.byteT(); break;
      case 'fail': this.finish(this.fail); break;
      case 'done': this.finish(0); break;
      default: this.phase = null;
    }
  }
  // turn the bytes of a Write Track into sectors: F5 and F6 are sync marks, F7 writes the CRC, FE starts an ID field
  // (track, side, sector, length code) and F8-FB a data field
  formatTrack(b) {
    const sectors = []; let id = null;
    for (let i = 0; i < b.length; i++) {
      const v = b[i];
      if (v === 0xFE && i + 4 < b.length) { id = { c: b[i + 1], h: b[i + 2], r: b[i + 3], n: b[i + 4] & 7 }; i += 4; }
      else if (id && v >= 0xF8 && v <= 0xFB) {
        const size = 128 << Math.min(id.n, 6), data = new Uint8Array(size);
        for (let k = 0; k < size && i + 1 + k < b.length; k++) data[k] = b[i + 1 + k];
        sectors.push({ c: id.c, h: id.h, r: id.r, n: id.n, data, deleted: v === 0xF8 || v === 0xF9, crcErr: false, noData: false });
        i += size; id = null;
      }
    }
    const old = this.trk();
    this.disk.setTrack(this.drive.cyl, 0, { mfm: this.dden, rate: old ? old.rate : 250, sectors }); this.disk.dirty = true;
  }
}
if (typeof module !== 'undefined') module.exports = { WD1793, FloppyDisk, parseIMD, parseTD0, td0Unpack, parseDiskImage, writeIMD, fdcCrc, FDC };
