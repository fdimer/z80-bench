// FD1793, ImageDisk and Teledisk checks (no disk image needed): node tests/fdc-test.js
// Optional: OSB_TD0_DIR=folder also reads every .td0 file in that folder (none are included in this repository).
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'wd1793.js'), 'utf8'), ctx, { filename: 'wd1793.js' });
vm.runInContext('this.WD1793 = WD1793; this.FloppyDisk = FloppyDisk; this.parseIMD = parseIMD; this.writeIMD = writeIMD; this.parseTD0 = parseTD0; this.parseDiskImage = parseDiskImage; this.fdcCrc = fdcCrc;', ctx);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
const HZ = 3993600;
// a disk in the Executive's format: 40 tracks, 5 sectors of 1024 bytes, double density; sector bytes = track ^ sector ^ index
const mk = () => { const d = new ctx.FloppyDisk('test'); for (let c = 0; c < 40; c++) d.setTrack(c, 0, { mfm: true, rate: 250, sectors: [1, 2, 3, 4, 5].map(r => ({ c, h: 0, r, n: 3, data: Uint8Array.from({ length: 1024 }, (_, i) => (c ^ r ^ i) & 0xFF), deleted: false, crcErr: false, noData: false })) }); return d; };
// ----- ImageDisk round trip -----
const d0 = mk(); d0.comment = 'Test disk\nsecond line'; d0.track(3, 0).sectors[2].data.fill(0xE5); d0.track(4, 0).sectors[0].deleted = true; d0.track(5, 0).sectors[1].crcErr = true;
const imd = ctx.writeIMD(d0, new Date(2026, 10, 13, 12, 0, 0)), d1 = ctx.parseIMD(imd, 'copy');
ok(String.fromCharCode(...imd.subarray(0, 4)) === 'IMD ' && imd.includes(0x1A), 'ImageDisk file has its header and comment terminator');
ok(d1.cylinders === 40 && d1.heads === 1 && d1.comment === 'Test disk\nsecond line', 'ImageDisk round trip keeps the geometry and the comment');
let same = true; for (let c = 0; c < 40; c++) d0.track(c, 0).sectors.forEach((s, i) => { const t = d1.track(c, 0).sectors[i]; if (t.c !== s.c || t.r !== s.r || t.n !== s.n || t.deleted !== s.deleted || t.crcErr !== s.crcErr || t.data.length !== 1024 || t.data.some((v, k) => v !== s.data[k])) same = false; });
ok(same && d1.track(0, 0).mfm && d1.track(0, 0).rate === 250, 'every sector, its ID, its marks and its data come back the same');
ok(imd.length < 40 * 5 * 1024 + 200, 'a sector filled with one byte is stored compressed');
let threw = false; try { ctx.parseIMD(new Uint8Array([1, 2, 3, 4])); } catch (e) { threw = true; } ok(threw, 'a file that is not ImageDisk is refused');
ok(ctx.fdcCrc([0xA1, 0xA1, 0xA1, 0xFE, 0, 0, 1, 2]) === 0xCA6F, 'CRC of a standard double-density ID field (track 0, side 0, sector 1, 512 bytes) is CA6Fh');
// ----- Teledisk -----
// Build a .td0 file here: a header, a comment, then tracks whose sectors use each of the three data encodings.
const td0File = (sig, tracks, comment) => {
  const o = [sig.charCodeAt(0), sig.charCodeAt(1), 0, 0, 21, 0x02, 2, comment ? 0x81 : 0x01, 0, 1, 0, 0];
  const w16 = v => o.push(v & 0xFF, v >> 8);
  if (comment) { const t = Array.from(comment.replace(/\n/g, '\0'), c => c === 'ü' ? 0x81 : c.charCodeAt(0)); w16(0); w16(t.length); o.push(96, 10, 24, 12, 0, 0, ...t); }
  for (const t of tracks) {
    o.push(t.sectors.length, t.c, t.fm ? 0x80 : 0, 0);
    for (const s of t.sectors) {
      o.push(t.c, 0, s.r, s.n, s.flags || 0, 0);
      if (s.flags & 0x30) continue;
      const body = s.enc === 0 ? s.data : s.body; w16(body.length + 1); o.push(s.enc, ...body);
    }
  }
  o.push(0xFF); return new Uint8Array(o);
};
// LZHUF, written out the way Teledisk's compressor works (4K window, matches of 3 to 60 bytes, adaptive Huffman codes)
function lzhufPack(src) {
  const N = 4096, F = 60, TH = 2, NC = 256 - TH + F, T = NC * 2 - 1, R = T - 1;
  const freq = new Uint32Array(T + 1), prnt = new Int32Array(T + NC), son = new Int32Array(T);
  for (let i = 0; i < NC; i++) { freq[i] = 1; son[i] = i + T; prnt[i + T] = i; }
  for (let i = 0, j = NC; j <= R; i += 2, j++) { freq[j] = freq[i] + freq[i + 1]; son[j] = i; prnt[i] = prnt[i + 1] = j; }
  freq[T] = 0xFFFF; prnt[R] = 0;
  const update = c0 => { let c = prnt[c0 + T]; do { const k = ++freq[c]; let l = c + 1; if (k > freq[l]) { while (k > freq[++l]); l--; freq[c] = freq[l]; freq[l] = k; const i = son[c]; prnt[i] = l; if (i < T) prnt[i + 1] = l; const j = son[l]; son[l] = i; prnt[j] = c; if (j < T) prnt[j + 1] = c; son[c] = j; c = l; } } while ((c = prnt[c]) !== 0); };
  const bits = []; const put = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push(v >> k & 1); };
  const encChar = c => { const path = []; let k = prnt[c + T]; do { path.push(k & 1); k = prnt[k]; } while (k !== R); for (let i = path.length - 1; i >= 0; i--) bits.push(path[i]); update(c); };
  const pLen = [3, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, ...Array(24).fill(7), ...Array(16).fill(8)];
  const pCode = [0x00, 0x20, 0x30, 0x40, 0x50, 0x58, 0x60, 0x68, 0x70, 0x78, 0x80, 0x88, 0x90, 0x94, 0x98, 0x9C, 0xA0, 0xA4, 0xA8, 0xAC, 0xB0, 0xB4, 0xB8, 0xBC,
    ...Array.from({ length: 24 }, (_, i) => 0xC0 + 2 * i), ...Array.from({ length: 16 }, (_, i) => 0xF0 + i)];
  const encPos = d => { const i = d >> 6; put(pCode[i] >> (8 - pLen[i]), pLen[i]); put(d & 0x3F, 6); };
  const buf = new Uint8Array(N).fill(0x20); let r = N - F;
  for (let p = 0; p < src.length;) {
    let best = 0, bpos = 0;      // find the longest match in what was already written (a plain search: speed doesn't matter here)
    for (let d = 0; d < N - F; d++) { const s0 = (r - d - 1) & (N - 1); let l = 0; while (l < F && p + l < src.length && buf[(s0 + l) & (N - 1)] === src[p + l] && (s0 + l) % N !== r) l++; if (l > best) { best = l; bpos = d; } }
    const take = best > TH ? best : 1;
    if (take > 1) { encChar(255 - TH + take); encPos(bpos); } else encChar(src[p]);
    for (let k = 0; k < take; k++) { buf[r] = src[p++]; r = (r + 1) & (N - 1); }
  }
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8); for (let i = 0; i < out.length; i++) for (let k = 0; k < 8; k++) out[i] = out[i] << 1 | bits[i * 8 + k]; return out;
}
{
  const raw = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) & 0xFF);
  const tracks = [
    { c: 0, sectors: [
      { r: 1, n: 3, enc: 0, data: raw },
      { r: 2, n: 3, enc: 1, body: [0x00, 0x02, 0xE5, 0x5A] },                                        // 512 times "E5 5A"
      { r: 3, n: 3, enc: 2, body: [0, 3, 0x41, 0x42, 0x43, 1, 200, 0x11, 0x22, 2, 4, 1, 2, 3, 4, 0, 5, 9, 9, 9, 9, 9] },  // "ABC", 200 x "11 22", 4 x "01 02 03 04", 5 x 09; the rest stays 0
      { r: 4, n: 3, flags: 0x10 },                                                                    // no data
      { r: 5, n: 3, enc: 0, data: raw.slice().fill(0xAA), flags: 0x06 } ] },                             // CRC error and deleted
    { c: 1, fm: true, sectors: [{ r: 1, n: 1, enc: 1, body: [0x80, 0x00, 0xE5, 0xE5] }] } ];
  const plain = td0File('TD', tracks, 'Test disk für Teledisk\nsecond line');
  const d = ctx.parseTD0(plain, 'test.td0'), t0 = d.track(0, 0);
  ok(d.cylinders === 2 && t0.mfm && !d.track(1, 0).mfm && d.track(1, 0).sectors[0].data.length === 256, 'Teledisk: two tracks, the first double density, the second single (the head byte\'s bit 7)');
  ok(d.comment === 'Test disk für Teledisk\nsecond line' && d.date === '1996-11-24', 'the comment block gives the label (code page 437 letters kept) and its date');
  ok(t0.sectors[0].data.every((v, i) => v === raw[i]), 'encoding 0: raw sector data');
  ok(t0.sectors[1].data.every((v, i) => v === (i & 1 ? 0x5A : 0xE5)), 'encoding 1: a two-byte pattern repeated');
  const e2 = [0x41, 0x42, 0x43]; for (let i = 0; i < 200; i++) e2.push(0x11, 0x22); for (let i = 0; i < 4; i++) e2.push(1, 2, 3, 4); for (let i = 0; i < 5; i++) e2.push(9);
  ok(t0.sectors[2].data.every((v, i) => v === (i < e2.length ? e2[i] : 0)), 'encoding 2: literal runs and repeated patterns of 2 and 4 bytes');
  ok(t0.sectors[3].noData && t0.sectors[4].crcErr && t0.sectors[4].deleted && !t0.sectors[0].crcErr, 'the sector flags: no data, CRC error, deleted data mark');
  const packed = lzhufPack(plain.subarray(12)), comp = new Uint8Array([0x74, 0x64, ...plain.subarray(2, 12), ...packed]);
  ok(packed.length < plain.length - 12, `the test's LZHUF packer shrinks the file body (${plain.length - 12} to ${packed.length} bytes)`);
  const dc = ctx.parseTD0(comp, 'test.td0'); let match = dc.comment === d.comment && dc.cylinders === 2;
  for (let c = 0; c < 2; c++) d.track(c, 0).sectors.forEach((s, i) => { const u = dc.track(c, 0).sectors[i]; if (u.r !== s.r || u.noData !== s.noData || u.data.some((v, k) => v !== s.data[k])) match = false; });
  ok(match && /advanced compression/.test(dc.header), 'a compressed ("td") file reads back the same as the plain one');
  ok(ctx.parseDiskImage(comp, 'x').cylinders === 2 && ctx.parseDiskImage(imd, 'x').cylinders === 40, 'parseDiskImage tells Teledisk and ImageDisk files apart by their first bytes');
  const back = ctx.parseIMD(ctx.writeIMD(d), 'x');
  ok(back.comment === d.comment && back.track(0, 0).sectors[2].data.every((v, i) => v === t0.sectors[2].data[i]) && !back.track(1, 0).mfm, 'a Teledisk disk saves as ImageDisk with its label, its data and its densities');
  let msg = ''; try { ctx.parseTD0(plain.subarray(0, plain.length - 300), 'cut'); } catch (e) { msg = e.message; } ok(/cut short/.test(msg), 'a cut-short Teledisk file is refused (' + msg + ')');
  msg = ''; const old = comp.slice(); old[4] = 10; try { ctx.parseTD0(old, 'old'); } catch (e) { msg = e.message; } ok(/not supported/.test(msg), 'old Teledisk 1.x compression is refused with a reason');
}
if (process.env.OSB_TD0_DIR) for (const f of fs.readdirSync(process.env.OSB_TD0_DIR).filter(f => /\.td0$/i.test(f)).sort()) {
  let d = null, err = ''; try { d = ctx.parseTD0(fs.readFileSync(path.join(process.env.OSB_TD0_DIR, f)), f); } catch (e) { err = e.message; }
  ok(d && d.cylinders >= 40, `${f}: ${d ? d.describe() + (d.comment ? ' · ' + d.comment.split('\n')[0] : '') : err}`);
}
// ----- the controller -----
const f = new ctx.WD1793(HZ, { clock: 1 }), drv = { disk: null, cyl: 7 }; let irq = 0, irqs = 0; f.onIntrq = l => { if (l && !irq) irqs++; irq = l; };
const run = ms => f.advance(Math.round(HZ * ms / 1000));
const until = (cond, ms) => { let t = 0; while (!cond() && t < ms * HZ / 1000) { f.advance(40); t += 40; } return cond(); };
const waitDone = ms => until(() => !(f.read(0) & 1), ms || 3000);
f.drive = drv; run(1); f.write(0, 0xD0); run(1);
f.write(0, 0x03); ok(f.read(0) & 1, 'Restore: busy at once');
ok(waitDone(1000) && drv.cyl === 0 && f.track === 0 && (f.read(0) & 0x04), 'Restore steps the head back to track 0 and reports TR00');
ok(irqs >= 1, 'and raises INTRQ'); f.read(0); ok(irq === 0, 'reading the status register clears INTRQ');
f.write(3, 12); f.write(0, 0x13); const t0 = Date.now(); let steps = 0; { let t = 0; while (f.read(0) & 1) { f.advance(400); t += 400; } steps = t / HZ * 1000; }
ok(drv.cyl === 12 && f.track === 12 && Math.abs(steps - 12 * 60) < 30, 'Seek to track 12 at the slowest rate takes 12 x 60 ms with the 1 MHz clock (' + Math.round(steps) + ' ms)');
f.write(0, 0x53); waitDone(); ok(drv.cyl === 13 && f.track === 13, 'Step in with the update flag moves the head and the track register');
f.write(0, 0x73); waitDone(); f.write(0, 0x23); waitDone(); ok(drv.cyl === 11 && f.track === 12, 'Step out with update, then Step without: the head moves twice, the register once'); f.write(0, 0x43); waitDone(); ok(drv.cyl === 12, 'Step in without update');
f.write(1, 12);
// no disk: a read never ends until Force Interrupt
f.write(2, 1); f.write(0, 0x88); run(1500); ok((f.read(0) & 1) === 1, 'no disk in the drive: Read Sector stays busy (no index pulses)');
f.write(0, 0xD0); ok(!(f.read(0) & 1), 'Force Interrupt ends it'); f.write(0, 0xD0);      // a second one, with nothing running, brings back the type I status
drv.disk = mk();
ok(until(() => f.read(0) & 0x02, 250) && until(() => !(f.read(0) & 0x02), 50), 'with a disk in, the index bit pulses once a revolution');
// read a sector by polling, as the ROM does
const rd = (cmd) => { const out = []; f.write(0, cmd); let t = 0; for (;;) { const s = f.read(0); if (!(s & 1)) break; if (s & 2) out.push(f.read(3)); f.advance(40); t += 40; if (t > 3 * HZ) break; } return out; };
f.write(2, 4); let got = rd(0x88);
ok(got.length === 1024 && got.every((v, i) => v === ((12 ^ 4 ^ i) & 0xFF)) && !(f.read(0) & 0x1C), 'Read Sector returns the 1024 bytes of track 12 sector 4, with no error bits');
{ f.write(2, 2); f.write(0, 0x88); let t = 0, first = 0, last = 0, n = 0; for (;;) { const s = f.read(0); if (!(s & 1)) break; if (s & 2) { f.read(3); if (!n) first = t; last = t; n++; } f.advance(8); t += 8; }
  const per = (last - first) / (n - 1) / HZ * 1e6; ok(Math.abs(per - 32) < 0.5, 'data bytes arrive every 32 us in double density (' + per.toFixed(1) + ' us)'); }
{ f.write(2, 3); f.write(0, 0x88); let n = 0; while (f.read(0) & 1) { if (f.read(0) & 2 && n++ % 2 === 0) f.read(3); f.advance(120); } ok(f.read(0) & 0x04, 'a program that is too slow to take every byte gets Lost Data'); }
f.write(2, 9); f.write(0, 0x88); { let t = 0; while (f.read(0) & 1) { f.advance(400); t += 400; } ok((f.read(0) & 0x10) && Math.abs(t / HZ - 1.0) < 0.1, 'a sector that is not on the track: Record Not Found after five revolutions (' + (t / HZ).toFixed(2) + ' s)'); }
drv.disk.track(12, 0).sectors[0].crcErr = true; f.write(2, 1); rd(0x88); ok(f.read(0) & 0x08, 'a sector recorded with a bad CRC sets the CRC error bit'); drv.disk.track(12, 0).sectors[0].crcErr = false;
drv.disk.track(12, 0).sectors[1].deleted = true; f.write(2, 2); rd(0x88); ok(f.read(0) & 0x20, 'a deleted data mark sets the record type bit'); drv.disk.track(12, 0).sectors[1].deleted = false;
f.write(2, 4); got = rd(0x98); ok(got.length === 2048 && f.sector === 6 && (f.read(0) & 0x10), 'multiple records: sectors 4 and 5 are read, then Record Not Found for sector 6');
// read address
got = rd(0xC0); ok(got.length === 6 && got[0] === 12 && got[1] === 0 && got[2] >= 1 && got[2] <= 5 && got[3] === 3 && f.sector === 12 && ((got[4] << 8 | got[5]) === ctx.fdcCrc([0xA1, 0xA1, 0xA1, 0xFE, got[0], got[1], got[2], got[3]])), 'Read Address returns the next ID field with its CRC and copies the track into the sector register');
f.dden = false; f.write(0, 0xC0); { let t = 0; while (f.read(0) & 1) { f.advance(400); t += 400; } ok(f.read(0) & 0x10, 'with the density pin set wrong, no ID can be read: Record Not Found'); } f.dden = true;
// write a sector
const wr = (cmd, fn) => { f.write(0, cmd); let i = 0, t = 0; for (;;) { const s = f.read(0); if (!(s & 1)) break; if (s & 2) f.write(3, fn(i++)); f.advance(40); t += 40; if (t > 3 * HZ) break; } return i; };
f.write(2, 5); let n = wr(0xA8, i => (i * 3) & 0xFF);
ok(n === 1024 && drv.disk.track(12, 0).sectors[4].data.every((v, i) => v === ((i * 3) & 0xFF)) && drv.disk.dirty && !(f.read(0) & 0x5C), 'Write Sector stores the 1024 bytes supplied and marks the disk changed');
drv.disk.writeProtected = true; f.write(2, 5); n = wr(0xA8, () => 0); ok(n === 0 && (f.read(0) & 0x40), 'a write-protected disk refuses the write'); drv.disk.writeProtected = false;
// verify flag
f.write(3, 20); f.write(0, 0x17); waitDone(); ok(drv.cyl === 20 && !(f.read(0) & 0x18), 'Seek with verify finds the track number in an ID field');
f.write(1, 30); f.write(3, 30); f.write(0, 0x17); waitDone(); ok(f.read(0) & 0x10, 'Seek with verify on the wrong track reports a seek error'); f.write(1, 20);
// format a track: 10 sectors of 256 bytes, single density pattern written as double density bytes for the test
{ const b = []; const rep = (v, k) => { for (let i = 0; i < k; i++) b.push(v); };
  rep(0x4E, 60); for (let r = 1; r <= 10; r++) { rep(0x00, 12); rep(0xF5, 3); b.push(0xFE, 20, 0, r, 1, 0xF7); rep(0x4E, 22); rep(0x00, 12); rep(0xF5, 3); b.push(0xFB); rep(0xE5, 256); b.push(0xF7); rep(0x4E, 54); }
  const fed = wr(0xF4, i => i < b.length ? b[i] : 0x4E);
  const t = drv.disk.track(20, 0);
  ok(fed >= 6200 && fed <= 6260, 'Write Track asks for one revolution of bytes (' + fed + ')');
  ok(t.sectors.length === 10 && t.sectors.every((s, i) => s.c === 20 && s.r === i + 1 && s.n === 1 && s.data.length === 256 && s.data.every(v => v === 0xE5)), 'and the track is formatted as written: 10 sectors of 256 bytes filled with E5h');
  f.write(2, 7); got = rd(0x88); ok(got.length === 256 && got[0] === 0xE5, 'a sector of the newly formatted track reads back'); }
f.drive = null; f.reset(); ok(f.read(0) & 1, 'reset starts a Restore'); run(16000); ok(!(f.read(0) & 1) && (f.read(0) & 0x10), 'which gives up with a seek error after 255 steps when no drive is selected');
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
