// Headless Osborne Executive run: node tests/osborne-run.js path/to/rom.bin [seconds] [keys...]
// The ROM is not part of this repository. Prints the screen text and machine state.
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'm6821.js', 'z80sio.js', 'wd1793.js', 'memchips.js', 'osborne.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.Osborne = Osborne; this.OSB = OSB; this.disasm = disasm;', ctx);
const [romPath, secs = '3', ...keys] = process.argv.slice(2);
const m = new ctx.Osborne(fs.readFileSync(romPath));
const show = label => {
  console.log(`--- ${label}: ${(m.cpu.pc).toString(16)}h PC, frame ${m.frames}, video ${m.vidEna ? 'on' : 'off'}, PA ${m.pa.toString(16)}h, I ${m.cpu.i.toString(16)}h, IM ${m.cpu.im}, IFF1 ${m.cpu.iff1}`);
  m.textRows().forEach((l, i) => { if (l.trim()) console.log(String(i).padStart(2), '|' + l); });
};
const run = s => m.run(Math.round(s * ctx.OSB.CPU_HZ));
run(+secs); show('after ' + secs + ' s');
for (const k of keys) { m.key(k, true); run(0.1); m.key(k, false); run(0.6); show('after key ' + k); }
if (module.parent === null && process.env.OSB_STATE) fs.writeFileSync(process.env.OSB_STATE, JSON.stringify({ pc: m.cpu.pc }));
