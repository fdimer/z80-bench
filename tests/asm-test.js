// Assembles every instruction form in the opcode table and checks the bytes; then a sample program and error cases.
// Usage: node tests/asm-test.js
const fs=require('fs');
const core=fs.readFileSync(require('path').join(__dirname,'..','src','z80core.js'),'utf8').replace(/if \(typeof module[^\n]*/,'');
const asm=fs.readFileSync(require('path').join(__dirname,'..','src','z80asm.js'),'utf8').replace(/if \(typeof module[^\n]*/,'');
eval(core+'\n'+asm+'\nglobalThis.T={assemble,ASM_TABLE,disasm};');
const dis=T.disasm, ASM_TABLE=T.ASM_TABLE, asmb=T.assemble;
let n=0,bad=0;
for (const [key,tpl] of ASM_TABLE){
  const src='  ORG 100h\n  '+key.replace('{NN}','1234h').replace('{N}','12h').replace('+{D}','-3').replace('{E}','$+20');
  const r=asmb(src);
  const exp=tpl.map(k=>typeof k==='number'?k:k==='n'?0x12:k==='nl'?0x34:k==='nh'?0x12:k==='d'?0xFD:k==='e'?(20-tpl.length)&0xFF:null);
  const got=r.chunks[0]?r.chunks[0].bytes:[];
  n++;
  if(r.errors.length||got.join()!==exp.join()){bad++; if(bad<15) console.log('FAIL',key,JSON.stringify(r.errors),got.map(b=>b.toString(16)),exp.map(b=>b.toString(16)));}
}
console.log(n,'forms,',bad,'failures');
// realistic program
const prog=`
; test program
PORT    EQU 01h
STACK   =   1000h
        ORG 0
start:  ld sp,STACK
        ld a,0
loop:   out (PORT),a
        inc a
        ld (count),a
        call sub
        jr loop
sub:    ld b,a
        ld ix,table
        ld c,(ix+2)
        ld (ix),c
        bit 7,(iy-1)
        ex af,af'
        add 5
        sub a,b
        jp (hl)
        jp ix
        in a,(c)
        rst 38h
        im 2
        djnz sub
        ret
table:  db 1,2,"AB",'C'
count:  dw table, $
        ds 3,0FFh
`;
const r=asmb(prog);
console.log('errors',r.errors);
const mem=new Uint8Array(65536); for(const c of r.chunks) c.bytes.forEach((b,i)=>mem[c.addr+i]=b);
let a=0; const end=r.chunks[r.chunks.length-1].addr+r.chunks[r.chunks.length-1].bytes.length;
while(a<0x2A){const d=dis(x=>mem[x],a); console.log(a.toString(16).padStart(4,'0'),d.text); a+=d.len;}
console.log('table at',r.syms.get('TABLE').toString(16),'bytes',[...mem.slice(r.syms.get('TABLE'),end)].map(b=>b.toString(16)).join(' '));
const e=asmb('  jr far\n  ds 200\nfar: nop\n  ld a,300\n  foo b\n  ld a,undefined_label');
console.log(e.errors);
