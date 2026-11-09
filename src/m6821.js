// Motorola MC6821 PIA: two 8-bit ports with data direction registers, control lines
// CA1/CA2/CB1/CB2 and interrupt outputs IRQA/IRQB.
// Register select rs: 0 = port A data or DDR A, 1 = CRA, 2 = port B data or DDR B, 3 = CRB.
class M6821 {
  constructor(name) {
    this.name = name || 'PIA';
    this.inA = 0xFF; this.inB = 0xFF;            // levels driven onto input pins from outside (pulled up by default)
    this.ca1 = 1; this.cb1 = 1; this.ca2in = 1; this.cb2in = 1;
    this.onPA = () => {}; this.onPB = () => {}; this.onCA2 = () => {}; this.onCB2 = () => {};
    this.reset();
  }
  reset() {
    this.ora = 0; this.orb = 0; this.ddra = 0; this.ddrb = 0; this.cra = 0; this.crb = 0;
    this.irqa1 = this.irqa2 = this.irqb1 = this.irqb2 = false;
    this.ca2out = 1; this.cb2out = 1;
    this.onPA(this.pa()); this.onPB(this.pb());
  }
  // pin levels: outputs show the output register, inputs show what the outside drives
  pa() { return ((this.ora & this.ddra) | (this.inA & ~this.ddra)) & 0xFF; }
  pb() { return ((this.orb & this.ddrb) | (this.inB & ~this.ddrb)) & 0xFF; }
  ca2() { return this.cra & 0x20 ? this.ca2out : this.ca2in; }
  cb2() { return this.crb & 0x20 ? this.cb2out : this.cb2in; }
  irqA() { return (this.irqa1 && !!(this.cra & 1)) || (this.irqa2 && !(this.cra & 0x20) && !!(this.cra & 0x08)); }
  irqB() { return (this.irqb1 && !!(this.crb & 1)) || (this.irqb2 && !(this.crb & 0x20) && !!(this.crb & 0x08)); }
  ctrl(cr, f1, f2) { return (cr & 0x3F) | (f1 ? 0x80 : 0) | (f2 && !(cr & 0x20) ? 0x40 : 0); }
  read(rs) {
    switch (rs & 3) {
      case 0:
        if (!(this.cra & 4)) return this.ddra;
        this.irqa1 = this.irqa2 = false;
        if ((this.cra & 0x30) === 0x20) {            // CA2 read strobe: handshake (until CA1) or pulse
          this.setCa2Out(0); if (this.cra & 0x08) this.setCa2Out(1);
        }
        return this.pa();                          // port A always reads the pins
      case 1: return this.ctrl(this.cra, this.irqa1, this.irqa2);
      case 2:
        if (!(this.crb & 4)) return this.ddrb;
        this.irqb1 = this.irqb2 = false;
        return this.pb();                          // output bits read back the output register
      default: return this.ctrl(this.crb, this.irqb1, this.irqb2);
    }
  }
  write(rs, v) {
    v &= 0xFF;
    switch (rs & 3) {
      case 0: if (this.cra & 4) this.ora = v; else this.ddra = v; this.onPA(this.pa()); break;
      case 1:
        this.cra = v & 0x3F;
        if ((v & 0x30) === 0x30) this.setCa2Out((v >> 3) & 1); else if ((v & 0x30) === 0x20) this.setCa2Out(1);
        break;
      case 2:
        if (this.crb & 4) {
          this.orb = v;
          if ((this.crb & 0x30) === 0x20) { this.setCb2Out(0); if (this.crb & 0x08) this.setCb2Out(1); }   // CB2 write strobe
        } else this.ddrb = v;
        this.onPB(this.pb()); break;
      default:
        this.crb = v & 0x3F;
        if ((v & 0x30) === 0x30) this.setCb2Out((v >> 3) & 1); else if ((v & 0x30) === 0x20) this.setCb2Out(1);
    }
  }
  setCa2Out(l) { if (this.ca2out !== l) { this.ca2out = l; this.onCA2(l); } }
  setCb2Out(l) { if (this.cb2out !== l) { this.cb2out = l; this.onCB2(l); } }
  // control inputs: an active edge sets the flag (CRx bit 1 / bit 4: 1 = rising edge, 0 = falling edge)
  setCA1(l) {
    l = l ? 1 : 0; if (l === this.ca1) return; this.ca1 = l;
    if (l === ((this.cra >> 1) & 1)) { this.irqa1 = true; if ((this.cra & 0x38) === 0x20) this.setCa2Out(1); }
  }
  setCB1(l) {
    l = l ? 1 : 0; if (l === this.cb1) return; this.cb1 = l;
    if (l === ((this.crb >> 1) & 1)) { this.irqb1 = true; if ((this.crb & 0x38) === 0x20) this.setCb2Out(1); }
  }
  setCA2(l) { l = l ? 1 : 0; if (l === this.ca2in) return; this.ca2in = l; if (!(this.cra & 0x20) && l === ((this.cra >> 4) & 1)) this.irqa2 = true; }
  setCB2(l) { l = l ? 1 : 0; if (l === this.cb2in) return; this.cb2in = l; if (!(this.crb & 0x20) && l === ((this.crb >> 4) & 1)) this.irqb2 = true; }
}
if (typeof module !== 'undefined') module.exports = { M6821 };
