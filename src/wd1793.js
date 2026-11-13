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
  ids() { const t = this.trk(); return t && t.mfm === this.dden ? t.sectors : []; }
  byteT(t) { const tr = t || this.trk(), rate = tr ? tr.rate : 250; return this.cpuHz * (this.dden ? 8 : 16) / (rate * 1000); }
  // T-states until sector index i's ID field comes round (sectors are spaced evenly after the index)
  toSector(i, n) { const at = this.indexT + (this.revT - this.indexT) * i / n; let d = at - this.rot; if (d < 0) d += this.revT; return d; }
  indexPin() { return !!this.disk && this.rot < this.indexT; }
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
    if (this.type === 1) {
      s &= ~(FDC.INDEX | FDC.TR00 | FDC.HEADLOADED);
      if (this.indexPin()) s |= FDC.INDEX;
      if (this.drive && this.drive.cyl === 0) s |= FDC.TR00;
      if (this.hld) s |= FDC.HEADLOADED;
      if (this.disk && this.disk.writeProtected) s |= FDC.WP;
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
    if (!this.phase) return;
    this.wait -= t;
    while (this.phase && this.wait <= 0) this.tick();
  }
  finish(bits) {
    if (bits) this.status |= bits;
    this.busy = false; this.drq = false; this.phase = null; this.intrq = true; this.onIntrq(1);
  }
  stepHead(dir) { const d = this.drive; if (d) d.cyl = Math.max(0, Math.min(this.maxCyl, d.cyl + dir)); }
  tick() {
    const c = this.cmd;
    switch (this.phase) {
      // ----- type I -----
      case 'restore':
        if (this.drive && this.drive.cyl === 0) { this.track = 0; this.phase = 'verify'; break; }
        if (this.left-- <= 0) { this.track = 0; this.finish(FDC.SEEKERR); break; }      // 255 steps and TR00* never came (no drive selected)
        this.stepHead(-1); this.wait += this.stepT; break;
      case 'seek':
        if (this.track === this.data) { this.phase = 'verify'; break; }
        this.dir = this.data > this.track ? 1 : -1; this.track = (this.track + this.dir) & 0xFF; this.stepHead(this.dir);
        this.wait += this.stepT; break;
      case 'step1':
        if (c & 0x10) this.track = (this.track + this.dir) & 0xFF;
        if (!(this.dir < 0 && this.drive && this.drive.cyl === 0)) this.stepHead(this.dir); else if (c & 0x10) this.track = 0;
        this.phase = 'verify'; this.wait += this.stepT; break;
      case 'verify':
        if (!(c & 0x04)) { this.finish(0); break; }
        this.phase = 'verify2'; this.wait += 15 * this.slow * this.ms; this.revs = 0; break;
      case 'verify2': {                   // read an ID and compare its track number with the track register
        if (!this.disk) { this.wait = Infinity; break; }                    // no index pulses: the chip waits for ever
        const ids = this.ids(), hit = ids.find(s => s.c === this.track);
        if (hit) { this.wait += this.toSector(ids.indexOf(hit), ids.length) + 10 * this.byteT(); this.phase = 'done'; break; }
        this.phase = 'fail'; this.fail = FDC.SEEKERR; this.wait += 5 * this.revT; break;
      }
      // ----- type II: find the sector -----
      case 'find': {
        if (!this.disk) { this.wait = Infinity; break; }
        if ((c & 0xE0) === 0xA0 && this.disk.writeProtected) { this.finish(FDC.WP); break; }
        const ids = this.ids(), i = ids.findIndex(s => s.c === this.track && s.r === this.sector && !s.noData);
        if (i < 0) { this.phase = 'fail'; this.fail = FDC.RNF; this.wait += 5 * this.revT; break; }
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
        s.data[this.pos++] = this.data; this.disk.dirty = true;
        if (this.pos >= s.data.length) { s.deleted = !!(c & 1); s.crcErr = false; this.phase = 'wrend'; this.wait += 3 * this.byteT(); break; }
        this.drq = true; this.wait += this.byteT(); break;
      }
      case 'wrend':
        if (c & 0x10) { this.sector = (this.sector + 1) & 0xFF; this.phase = 'find'; this.wait += this.byteT(); break; }
        this.finish(0); break;
      // ----- read address: the next ID field to come round -----
      case 'addr': {
        if (!this.disk) { this.wait = Infinity; break; }
        const ids = this.ids();
        if (!ids.length) { this.phase = 'fail'; this.fail = FDC.RNF; this.wait += 5 * this.revT; break; }
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
        if (this.disk.writeProtected) { this.finish(FDC.WP); break; }
        this.drq = true; this.phase = 'wtindex'; this.wait += 3 * this.byteT(); break;
      }
      case 'wtindex':
        if (this.drq) { this.finish(FDC.LOST); break; }                    // no first byte within three byte times
        this.buf = []; this.wtLen = Math.floor(this.revT / this.byteT());
        this.phase = 'wt'; this.wait += this.revT - this.rot; break;       // writing starts at the leading edge of the index pulse
      case 'wt':
        if (this.drq) { this.status |= FDC.LOST; this.data = 0; }
        this.buf.push(this.data);
        if (this.buf.length >= this.wtLen) { this.drq = false; this.formatTrack(this.buf); this.finish(0); break; }
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
if (typeof module !== 'undefined') module.exports = { WD1793, FloppyDisk, parseIMD, writeIMD, fdcCrc, FDC };
