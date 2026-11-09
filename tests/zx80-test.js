// ZX80 video-logic checks with a synthetic ROM (no Sinclair code): node tests/zx80-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console }; vm.createContext(ctx);
for (const f of ['z80core.js', 'z80asm.js', 'zx80.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx, { filename: f });
vm.runInContext('this.ZX80 = ZX80; this.ZX = ZX; this.assemble = assemble;', ctx);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
// A tiny display driver in the ZX80 style: 4 characters then HALT, 8 scan lines per frame.
const src = `
        ORG  0
        ld   sp,4400h
        ld   a,0Eh
        ld   i,a            ; font page 0E00h, as in the ZX80 ROM
        im   1
frame:  in   a,(0FEh)       ; vertical sync on (read with A0 low)
        ld   b,0
vs:     djnz vs
        out  (0FFh),a       ; vertical sync off, line counter cleared
        ld   c,8
        ld   hl,0C000h      ; display file 4000h seen through the A15 mirror
        ld   a,70h
        ei
        ld   r,a
        jp   (hl)           ; chars fetched with R = 71h-74h, HALT at 75h, /INT when R reaches 00h
        ORG  38h
        pop  de
        dec  c
        jr   z,frame
        ld   hl,0C000h
        ld   a,70h
        ei
        ld   r,a
        jp   (hl)
        ORG  0E08h          ; character 1: a diagonal, row r = 80h >> r
        db   80h,40h,20h,10h,08h,04h,02h,01h
        db   0FFh,81h,81h,81h,81h,81h,81h,0FFh   ; character 2: a box
`;
const r = ctx.assemble(src); ok(!r.errors.length, 'synthetic ROM assembles ' + (r.errors[0] ? r.errors[0].msg : ''));
const rom = new Uint8Array(0x1000); for (const c of r.chunks) c.bytes.forEach((v, i) => { rom[c.addr + i] = v; });
const m = new ctx.ZX80(rom);
// display file: char 1, char 2, inverse char 1 (bit 7), char 2, HALT
[0x01, 0x02, 0x81, 0x02, 0x76].forEach((v, i) => { m.ram[i] = v; });
m.run(200000);
ok(m.frames >= 3, `vertical sync recognised (${m.frames} frames)`);
// find the drawn lines in the last full picture
const W = ctx.ZX.W, rows = [];
for (let y = 0; y < ctx.ZX.H; y++) { let s = ''; for (let x = 0; x < W; x++) s += m.front[y * W + x] ? '#' : '.'; if (s.includes('#')) rows.push([y, s]); }
ok(rows.length === 8, `8 scan lines drawn (got ${rows.length})`);
// line 0 follows vertical sync rather than a horizontal sync, so measure the others against line 1
const first = rows.length > 1 ? Math.min(...rows.slice(1).map(([, s]) => s.indexOf('#') - rows.slice(1).findIndex(q => q[1] === s))) : -1;
const starts = rows.map(([, s]) => s.search(/[#]/));
console.log('     first ink x per line:', starts.join(' '));
const x1 = rows.length > 1 ? starts[1] - 1 : 0;   // line 1 starts with char 1 row 1 = .#......
const cells = rows.map(([, s], i) => i === 0 ? s.slice(starts[0], starts[0] + 32) : s.slice(x1, x1 + 32));
console.log(cells.map((c, i) => '     ' + i + ' ' + c).join('\n'));
const expect = r => { const d = (0x80 >> r), box = r === 0 || r === 7 ? 0xFF : 0x81; const b = v => v.toString(2).padStart(8, '0').replace(/1/g, '#').replace(/0/g, '.'); return b(d) + b(box) + b(d ^ 0xFF) + b(box); };
ok(cells.every((c, i) => c === expect(i)), 'each line shows the font row picked by the line counter, inverse video on bit 7');
ok(rows.every(([y], i) => i === 0 || y === rows[i - 1][0] + 1), 'lines are consecutive (one per interrupt acknowledge)');
// the data bus during a character fetch carries the forced NOP
m.cpu.log = true;
let seen = null; for (let i = 0; i < 5000 && !seen; i++) { const c0 = m.cpu.pc; m.syncInt(); const cyc = m.cpu.step(); m.afterStep(cyc); for (const c of cyc) if (c.k === 'M1' && c.a >= 0xC000 && c.a < 0xC004) seen = c; }
ok(seen && seen.d === 0x00, 'character fetches put a NOP on the CPU data bus');
// keyboard: half-row A11 (1-5), key 3 is D2
m.key('3', true); ok((m.input(0xF7FE) & 0x1F) === 0x1B, 'key 3 reads on D2 of half-row A11');
ok((m.input(0xFEFE) & 0x1F) === 0x1F, 'other half-rows unaffected'); m.key('3', false);
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
