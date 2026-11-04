// Runs the zexdoc/zexall CP/M instruction exerciser against the CPU core.
// Usage: node tests/zexdoc-run.js path/to/zexdoc.com   (takes about 3 minutes)
const fs = require('fs');
const { Z80 } = require(require('path').join(__dirname, '..', 'src', 'z80core.js'));
const file = process.argv[2];
const mem = new Uint8Array(65536);
const prog = fs.readFileSync(file);
mem.set(prog, 0x100);
mem[0] = 0x76;          // HALT on warm boot
mem[5] = 0xC9;          // BDOS: RET
const bus = { read: a => mem[a], write: (a, v) => { mem[a] = v; }, input: () => 0xFF, output: () => {} };
const cpu = new Z80(bus);
cpu.log = false;
cpu.pc = 0x100; cpu.sp = 0xF000;
let out = '';
const t0 = Date.now();
for (;;) {
  if (cpu.pc === 5) {
    if (cpu.c === 2) process.stdout.write(String.fromCharCode(cpu.e));
    else if (cpu.c === 9) { let a = cpu.de, s = ''; while (mem[a] !== 0x24) s += String.fromCharCode(mem[a++]); process.stdout.write(s); }
  }
  cpu.step();
  if (cpu.halted) break;
}
console.log('\nDone in', ((Date.now() - t0) / 1000).toFixed(0), 's');
