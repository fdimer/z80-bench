// ZX Spectrum 48K checks. The ROM is not part of this repository: SPEC_ROM=/path/to/48.rom node tests/spectrum-test.js
// Without SPEC_ROM only the checks that need no ROM run.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'spectrum.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.SpecMachine = SpecMachine; this.SpecTape = SpecTape; this.SPEC = SPEC;', ctx);
const { SpecMachine, SpecTape, SPEC } = ctx;
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

// ----- the ULA's timing, no ROM needed -----
{
  const m = new SpecMachine();
  ok(SPEC.FRAME_T === 312 * 224, 'a frame is 312 lines of 224 T-states (69,888)');
  ok([14334, 14335, 14336, 14337, 14338, 14339, 14340, 14341, 14342, 14343].map(t => m.delay(t)).join() === '0,6,5,4,3,2,1,0,0,6', 'contention from 14,335: 6, 5, 4, 3, 2, 1, 0, 0 in each 8 T-states');
  ok(m.delay(14335 + 128) === 0 && m.delay(14335 + 224) === 6 && m.delay(14335 + 191 * 224 + 127) === 0 && m.delay(14335 + 192 * 224) === 0, 'only for the 128 T-states of each of the 192 lines of the picture');
  // a NOP at 4000h, run at T-state 14335 of the frame: the opcode fetch is held 6 T-states
  m.poke(0x4000, 0); m.cpu.pc = 0x4000; m.ft = 14335; m.cpu.iff1 = 0;
  ok(m.step() === 10, 'a NOP in contended RAM at 14,335 takes 4 + 6 T-states');
  m.poke(0x8000, 0); m.cpu.pc = 0x8000; m.ft = 14335; ok(m.step() === 4, 'the same NOP in the upper RAM takes 4');
  m.contended = false; m.cpu.pc = 0x4000; m.ft = 14335; ok(m.step() === 4, 'with contention switched off it takes 4');
  m.contended = true;
  // OUT (FEh),A from the upper RAM at the start of a picture line: N:1, C:3 -> held at the second T-state
  m.poke(0x8000, 0xD3); m.poke(0x8001, 0xFE); m.cpu.pc = 0x8000; m.cpu.a = 2; m.ft = 14335 - 8;
  const n = m.step(); ok(n === 11 + m.delay(14335 - 8 + 8) && m.border === 2, `OUT (FEh),A: the ULA port is held after its first T-state (${n} T-states), and the border is red`);
  // the floating bus: during the picture an odd port reads what the ULA is fetching
  m.ram[0] = 0x55; m.ram[0x1800] = 0x38;
  ok(m.floating(14338) === 0x55 && m.floating(14339) === 0x38 && m.floating(14342) === 0xFF && m.floating(1000) === 0xFF, 'floating bus: the bitmap byte, then its attribute, then idle (FFh); FFh outside the picture');
  // port FE: keys, and the EAR bit on an issue 3 or later board
  m.key('A', true); ok((m.keyRows(0xFD) & 1) === 0 && (m.keyRows(0xFE) & 1) === 1, 'a key reads low on its half-row (A on A9) only'); m.key('A', false);
  m.out = 0x10; ok(m.earBit() === 0x40, 'issue 3: bit 4 out reads back on EAR'); m.out = 0x08; ok(m.earBit() === 0, 'and bit 3 alone does not'); m.out = 0;
}
// ----- tapes, no ROM needed -----
const tapBlock = bytes => { let x = 0; for (const v of bytes) x ^= v; const b = [...bytes, x]; return [b.length & 255, b.length >> 8, ...b]; };
const prog = [0, 10, 9, 0, 0xF5, 0x22, ...[...'HELLO'].map(c => c.charCodeAt(0)), 0x22, 0x0D];           // 10 PRINT "HELLO"
const header = [0, 0, ...[...'hello     '].map(c => c.charCodeAt(0)), prog.length, 0, 10, 0, prog.length, 0];   // a program, autostart line 10
const tap = new Uint8Array([...tapBlock(header), ...tapBlock([0xFF, ...prog])]);
{
  const t = new SpecTape(tap);
  ok(t.blocks.length === 2 && /Program: "hello"/.test(t.blocks[0].desc) && new RegExp('data, ' + prog.length + ' bytes').test(t.blocks[1].desc), 'a TAP file reads as its two blocks: ' + t.blocks.map(b => b.desc).join('; '));
  let pulses = 0; for (let i = 0; i < t.n; i++) pulses++; ok(t.dur[0] >= 2168 && t.lvl[0] === 1, 'the signal starts with the leader: pulses of 2,168 T-states');
  const p = []; for (let i = 0; i < t.n; i++) p.push(t.dur[i]);
  const found = SpecTape.findBlocks(p);
  ok(found.length === 2 && found[1].data.length === prog.length + 2, 'the blocks are found again in the signal, checksums and all');
  const wav = SpecTape.toWav(t, 44100), back = new SpecTape(SpecTape.fromWav(wav, 'test.wav'));
  ok(back.blocks.filter(b => b.data).length === 2 && back.blocks[1].data.every((v, i) => v === t.blocks[1].data[i]), 'the tape as a WAV file and back: the same two blocks');
}

// ----- with the ROM -----
if (!process.env.SPEC_ROM) { console.log('(SPEC_ROM not set: the checks with the ROM were skipped)'); console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0); }
const rom = fs.readFileSync(process.env.SPEC_ROM);
const boot = () => { const m = new SpecMachine(); m.loadRom(rom); for (let f = 0; f < 150; f++) m.runFrame(); return m; };
const press = (m, keys, frames = 4) => { for (const k of keys) m.key(k, true); for (let f = 0; f < frames; f++) m.runFrame(); for (const k of keys) m.key(k, false); for (let f = 0; f < frames; f++) m.runFrame(); };
const type = (m, seq) => { for (const ks of seq) press(m, Array.isArray(ks) ? ks : [ks]); };
const text = m => m.screenText().filter(l => l.trim()).join(' | ');
{
  const m = boot();
  ok(m.screenText()[23].startsWith('(c) 1982 Sinclair Research Ltd'), 'the ROM starts and shows its copyright message');
  // interrupts once a frame
  const i0 = m.ints; for (let f = 0; f < 50; f++) m.runFrame(); ok(m.ints - i0 === 50, '50 frames, 50 interrupts');
  // PRINT 2+2 (P is PRINT at the K cursor; SYMBOL SHIFT + K is +)
  type(m, ['P', '2', ['SYMBOL SHIFT', 'K'], '2', 'ENTER']); for (let f = 0; f < 20; f++) m.runFrame();
  ok(/^4\b/.test(m.screenText()[0]) && /0 OK, 0:1/.test(text(m)), 'PRINT 2+2 typed on the keyboard gives 4 (' + text(m) + ')');
  // BORDER 2: the border turns red in the picture
  type(m, ['B', '2', 'ENTER']); for (let f = 0; f < 5; f++) m.runFrame();
  ok(m.border === 2 && m.fb[10 * SPEC.FW + 10] === 2, 'BORDER 2 makes the border red');
}
// loading the TAP: instantly, then from the signal
for (const instant of [true, false]) {
  const m = boot(); m.instant = instant; m.insertTape(tap, 'hello.tap');
  type(m, ['J', ['SYMBOL SHIFT', 'P'], ['SYMBOL SHIFT', 'P'], 'ENTER']); m.tapePlay = true;
  let f = 0; while (f < 1000 && !/HELLO/.test(text(m))) { m.runFrame(); f++; }
  ok(/HELLO/.test(text(m)), `LOAD "" ${instant ? 'instantly' : 'from the tape signal'}: the program loads and runs itself (${(f / 50).toFixed(1)} s): ${text(m)}`);
}
// SAVE, recorded from the MIC output, then loaded back from the recording
{
  const m = boot();
  type(m, ['1', '0', 'P', ['SYMBOL SHIFT', 'P'], 'O', 'K', ['SYMBOL SHIFT', 'P'], 'ENTER']);     // 10 PRINT "ok" (lower case: no CAPS)
  type(m, ['S', ['SYMBOL SHIFT', 'P'], 'T', ['SYMBOL SHIFT', 'P'], 'ENTER']);                    // SAVE "T"
  for (let f = 0; f < 50 && !/Start tape/.test(text(m)); f++) m.runFrame();
  ok(/Start tape/.test(text(m)), 'SAVE "T" asks to start the tape');
  m.recStart(); press(m, ['ENTER']); let f = 0; while (f < 600 && !/0 OK/.test(text(m))) { m.runFrame(); f++; }
  const pulses = m.recStop(), tapFile = pulses && SpecTape.tapFromPulses(pulses);
  ok(tapFile && new SpecTape(tapFile).blocks.length === 2, `the recording holds the header and the program (${(f / 50).toFixed(1)} s of saving)`);
  const m2 = boot(); m2.instant = false; m2.insertTape(SpecTape.fromPulses(pulses), 'rec.tzx'); type(m2, ['J', ['SYMBOL SHIFT', 'P'], ['SYMBOL SHIFT', 'P'], 'ENTER']); m2.tapePlay = true;
  let g = 0; while (g < 600 && !/Program: t/i.test(text(m2))) { m2.runFrame(); g++; } const named = /Program: t/i.test(text(m2)); for (let k = 0; k < 600 && !/0 OK/.test(text(m2)); k++) m2.runFrame();
  type(m2, ['R', 'ENTER']); for (let k = 0; k < 10; k++) m2.runFrame();
  ok(named && /^ok/.test(m2.screenText()[0]), 'and it loads back from the recording ("Program: T"), and RUN prints ok: ' + text(m2));
}
// snapshots: save and load back
{
  const m = boot(); type(m, ['B', '5', 'ENTER']); for (let f = 0; f < 5; f++) m.runFrame();
  const sna = m.saveSnapshot(), m2 = new SpecMachine(); m2.loadRom(rom); m2.loadSnapshot(sna, 'x.sna');
  for (let f = 0; f < 10; f++) m2.runFrame();
  ok(m2.border === 5 && m2.screenText()[23].startsWith('0 OK'), 'a .SNA snapshot saved and loaded back carries on where it was');
}
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
