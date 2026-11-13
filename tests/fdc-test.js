// FD1793 and ImageDisk checks (no disk image needed): node tests/fdc-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'wd1793.js'), 'utf8'), ctx, { filename: 'wd1793.js' });
vm.runInContext('this.WD1793 = WD1793; this.FloppyDisk = FloppyDisk; this.parseIMD = parseIMD; this.writeIMD = writeIMD; this.fdcCrc = fdcCrc;', ctx);
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
