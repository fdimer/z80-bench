// Checks T-state counts of representative instructions against Zilog datasheet values.
// Usage: node tests/timing-test.js
const { Z80 } = require(require('path').join(__dirname, '..', 'src', 'z80core.js'));
const cases = [
 ['00',4,'NOP'],['01 34 12',10,'LD BC,nn'],['09',11,'ADD HL,BC'],['03',6,'INC BC'],['34',11,'INC (HL)'],['36 05',10,'LD (HL),n'],
 ['10 FE',13,'DJNZ taken'],['18 00',12,'JR'],['22 00 80',16,'LD (nn),HL'],['3A 00 80',13,'LD A,(nn)'],['7E',7,'LD A,(HL)'],
 ['C5',11,'PUSH'],['C1',10,'POP'],['CD 00 10',17,'CALL'],['C9',10,'RET'],['C0',5,'RET NZ (not taken, Z set)'],['FF',11,'RST'],
 ['D3 01',11,'OUT (n),A'],['DB 01',11,'IN A,(n)'],['E3',19,'EX (SP),HL'],['F9',6,'LD SP,HL'],
 ['CB 00',8,'RLC B'],['CB 06',15,'RLC (HL)'],['CB 46',12,'BIT 0,(HL)'],
 ['ED 78',12,'IN A,(C)'],['ED 42',15,'SBC HL,BC'],['ED 43 00 80',20,'LD (nn),BC'],['ED 44',8,'NEG'],['ED 4D',14,'RETI'],['ED 47',9,'LD I,A'],
 ['ED 67',18,'RRD'],['ED A0',16,'LDI'],['ED B0',21,'LDIR repeat'],['ED A1',16,'CPI'],['ED A2',16,'INI'],['ED A3',16,'OUTI'],
 ['DD 21 00 00',14,'LD IX,nn'],['DD 7E 01',19,'LD A,(IX+d)'],['DD 36 01 05',19,'LD (IX+d),n'],['DD 34 01',23,'INC (IX+d)'],
 ['DD 86 01',19,'ADD A,(IX+d)'],['DD CB 01 06',23,'RLC (IX+d)'],['DD CB 01 46',20,'BIT 0,(IX+d)'],['DD E3',23,'EX (SP),IX'],['DD E9',8,'JP (IX)'],
];
const T = c => c.reduce((n,x)=>n+(x.k==='M1'?4:x.k==='MR'||x.k==='MW'?3:x.k==='IR'||x.k==='IW'?4:x.k==='IA'?6:x.n),0);
let bad=0;
for (const [hex,exp,name] of cases){
  const mem=new Uint8Array(65536); hex.split(' ').forEach((b,i)=>mem[i]=parseInt(b,16));
  const cpu=new Z80({read:a=>mem[a],write:(a,v)=>mem[a]=v,input:()=>0xFF,output:()=>{}});
  cpu.pc=0; cpu.sp=0x8000; cpu.bc=0x0302; cpu.hl=0x9000; cpu.f=0x40;
  const got=T(cpu.step());
  if(got!==exp){bad++;console.log('MISMATCH',name,'got',got,'expected',exp);}
}
// interrupts
for (const [im,exp] of [[1,13],[2,19],[0,13]]){
  const mem=new Uint8Array(65536);
  const cpu=new Z80({read:a=>mem[a],write:(a,v)=>mem[a]=v,input:()=>0xFF,output:()=>{}});
  cpu.sp=0x8000; cpu.im=im; cpu.iff1=cpu.iff2=1; cpu.intLine=true;
  const got=T(cpu.step()); if(got!==exp){bad++;console.log('INT IM',im,'got',got,'exp',exp);}
}
{ const mem=new Uint8Array(65536); const cpu=new Z80({read:a=>mem[a],write:(a,v)=>mem[a]=v,input:()=>0xFF,output:()=>{}});
  cpu.sp=0x8000; cpu.nmiPending=true; const got=T(cpu.step()); if(got!==11){bad++;console.log('NMI',got);} if(cpu.pc!==0x66){bad++;console.log('NMI pc');} }
console.log(bad? bad+' mismatches':'All '+(cases.length+4)+' timing checks match');
