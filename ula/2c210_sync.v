// ula2c210_sync: the Ferranti ULA 2C210 of the Sinclair ZX81 as a synchronous design, for an FPGA or CPLD.
//
// Source and terms: see ula/README.md. This design follows a netlist transcribed from a Ferranti logic diagram held
// in the Ferranti archive, which is for non-commercial use only; so is this file. Strictly not for commercial use
// of any kind.
//
// The chip makes its pulses from gate delays. Here every one of them is an edge of one clock, clk, at 13 MHz (twice
// the ZX81's 6.5 MHz), so a T-state of the Z80 is four clk periods, numbered by ph:
//   ph 0, 1: the Z80's clock is high (the chip's Q19 high);  ph 2, 3: low.   ph 0 and 2 are the chip's "OSC high".
//   character latch (LCLK)   chip: open while Q19 is low and OSC high, during M1      here: taken at the end of ph 2
//   shift register load (S/L) chip: a 35 ns pulse after Q19 rises, if MREQ is high     here: the edge that starts ph 0
//   dot clock                 chip: OSC rising                                         here: the edges that start ph 0 and ph 2
//   line counter              chip: Q19 falling, cleared at 207 or by INT acknowledge  here: the edge that starts ph 2
// What the chip does asynchronously from the bus (NMI and frame-sync latches, Q20, the counter reset) is done here
// on the next clk edge, at most 77 ns later. Everything the Z80 or the memory needs at once (memory selects, the NOP
// on the data lines, the keyboard, the address enable) is still combinational from the pins.
//
// ula2c210_core has no bidirectional pins, so it can be simulated anywhere; ula2c210_sync wraps it with the chip's
// pins. The core keeps to a small subset of Verilog (see ula/v2js.js, which runs it in the testbench).

module ula2c210_core (
  input  wire       clk,       // 13 MHz
  input  wire [7:0] d_in,      // D0-D7 as read at the pins
  output wire [7:0] d_pull,    // 1 = pull that data line low (open collector)
  input  wire [4:0] kbd_n,     // KBD0-KBD4 (low = key down)
  input  wire       usa_uk,    // pin 22
  input  wire       tape_in,   // pin 20
  input  wire       mreq_n,
  input  wire       m1_n,
  input  wire       rd_n,
  input  wire       wr_n,
  input  wire       iorq_n,
  input  wire       halt_n,
  input  wire       a15,
  input  wire       a14,
  input  wire       a1_in,     // A1' and A0' as read at the pins
  input  wire       a0_in,
  output wire [8:0] a_out,     // A0'-A8': row counter and character code
  output wire       a_oe,      // 1 = drive A0'-A8'
  output wire       phi_n,     // to TR2, which inverts it for the Z80
  output wire       nmi_pull,  // 1 = pull NMI low (open collector)
  output wire       rom_cs_n,
  output wire       ram_cs_n,
  output wire       sync,      // TV/TAPE: 1 = sync level
  output wire       black      // TV/TAPE when not sync: 1 = black, 0 = white
);
  reg [1:0] ph = 2'd0;         // quarter of the T-state
  reg [5:0] code = 6'd0;       // character code latch (the chip's Q11-Q16)
  reg       q17 = 1'b0;        // the fetch was a character
  reg       d7l = 1'b0;        // its D7: inverse video (the chip's Q18)
  reg       q32 = 1'b0;        // inverse video for the dots now in the shift register
  reg [7:0] sr = 8'd255;       // video shift register, Q1 (bit 0) to Q8 (bit 7); 0 = ink
  reg [7:0] cnt = 8'd0;        // line counter, 0-206
  reg       nmi_on = 1'b0;
  reg       fs = 1'b0;         // frame sync
  reg [2:0] row = 3'd0;        // character row counter
  reg       sync_d = 1'b0;
  reg       q20 = 1'b0;        // ROM kept selected from a character's refresh to the next M1
  reg       mreq_d = 1'b1;

  wire m1 = !m1_n;
  wire mreq = !mreq_n;

  // ---- clock ----
  always @(posedge clk) ph <= ph + 2'd1;
  assign phi_n = ph[1];

  // ---- character fetch: an opcode fetch from A15 high with D6 low, while not halted ----
  wire chr = !d_in[6] && mreq && a15 && halt_n;
  wire window = m1 && (ph == 2'd2);           // the latch is open
  wire nop = m1 && chr && !window;            // pull D0-D5 and D7 low: the Z80 reads a NOP
  always @(posedge clk) begin
    if (window) begin
      code <= d_in[5:0];
      q17 <= chr;
      d7l <= d_in[7];
    end
  end

  // ---- address lines: driven from the end of a character's M1 to the next M1 ----
  wire aena = q17 && m1_n;
  assign a_oe = aena;
  assign a_out = (code << 3) | row;

  // ---- video shift register: loaded as a T-state starts with MREQ high, after a character ----
  wire load = (ph == 2'd3) && mreq_n;
  always @(posedge clk) begin
    if (ph == 2'd1) sr <= (sr << 1) | 8'd1;
    if (ph == 2'd3) begin
      if (load && q17) sr <= ((sr << 1) | 8'd1) & ~d_in;
      else sr <= (sr << 1) | 8'd1;
    end
    if (load) q32 <= q17 && d7l;
  end

  // ---- line counter: 207 T-states, restarted by the interrupt acknowledge; sync at counts 16-31 ----
  wire intack = m1 && !iorq_n;
  always @(posedge clk) begin
    if (intack) cnt <= 8'd0;
    else if (ph == 2'd1) begin
      if (cnt == 8'd206) cnt <= 8'd0;
      else cnt <= cnt + 8'd1;
    end
  end
  wire line_sync = (cnt[7:4] == 4'd1);

  // ---- ports: any write ends frame sync; write with A0 low: NMI on; with A1 low: NMI off; read with A0 low:
  // keyboard, and frame sync starts unless the NMI generator is on ----
  wire iowr = !wr_n && !iorq_n;
  wire outfe = iowr && !a0_in;
  wire outfd = iowr && !a1_in;
  wire infe = !rd_n && !iorq_n && !a0_in;
  always @(posedge clk) begin
    if (outfd) nmi_on <= 1'b0;
    else if (outfe) nmi_on <= 1'b1;
    if (iowr || nmi_on) fs <= 1'b0;
    else if (infe) fs <= 1'b1;
  end
  assign nmi_pull = line_sync && nmi_on;
  assign sync = line_sync || fs;

  // ---- row counter: steps as each sync starts, held clear by frame sync ----
  always @(posedge clk) begin
    sync_d <= sync;
    if (fs) row <= 3'd0;
    else if (sync && !sync_d) row <= row + 3'd1;
  end

  // ---- video: ink where the shift register's last bit differs from the inverse flag; black during line sync ----
  assign black = line_sync || !(sr[7] ^ q32);

  // ---- data lines: the NOP, and the keyboard port (D0-D4 keys, D6 the USA/UK pin, D7 the tape input inverted) ----
  wire [4:0] keys = ~kbd_n;
  assign d_pull = (nop ? 8'hBF : 8'h00) | (infe ? ((tape_in << 7) | (!usa_uk << 6) | keys) : 8'h00);

  // ---- memory selects: by A14; the ROM also from a character's refresh until the next M1 ----
  always @(posedge clk) begin
    mreq_d <= mreq_n;
    if (m1) q20 <= 1'b0;
    else if (mreq && mreq_d) q20 <= aena;
  end
  wire ramacc = mreq && a14;
  wire romacc = mreq && !a14;
  wire romsel = romacc || q20 || (aena && mreq);
  assign ram_cs_n = !ramacc;
  assign rom_cs_n = !(romsel && !ramacc);
endmodule

// The chip's pins around the core. TV/TAPE is the chip's one three-level pin: here it is two outputs, to be mixed
// with resistors (see ula/README.md, "Electrical requirements").
module ula2c210_sync (
  input  wire       clk13,     // 13 MHz
  inout  wire [7:0] d,         // D0-D7: pins 32, 30, 28, 26, 24, 23, 21, 19
  input  wire [4:0] kbd_n,     // KBD0-KBD4: pins 33, 31, 29, 27, 25
  input  wire       usa_uk,    // pin 22
  input  wire       tape_in,   // pin 20
  input  wire       mreq_n,    // pin 9
  input  wire       m1_n,      // pin 10
  input  wire       rd_n,      // pin 6
  input  wire       wr_n,      // pin 8
  input  wire       iorq_n,    // pin 7
  input  wire       halt_n,    // pin 17
  input  wire       a15,       // pin 18
  input  wire       a14,       // pin 11
  inout  wire [8:0] a,         // A0'-A8': pins 5, 4, 3, 36, 37, 38, 39, 1, 2
  output wire       phi_n,     // pin 14
  inout  wire       nmi_n,     // pin 15 (open collector)
  output wire       rom_cs_n,  // pin 13
  output wire       ram_cs_n,  // pin 12
  output wire       tv_sync_n, // TV/TAPE (pin 16), part 1: low = sync
  output wire       tv_white   // TV/TAPE, part 2: high = white
);
  wire [7:0] d_pull;
  wire [8:0] a_out;
  wire a_oe, nmi_pull, sync, black;
  ula2c210_core core (
    .clk(clk13), .d_in(d), .d_pull(d_pull), .kbd_n(kbd_n), .usa_uk(usa_uk), .tape_in(tape_in),
    .mreq_n(mreq_n), .m1_n(m1_n), .rd_n(rd_n), .wr_n(wr_n), .iorq_n(iorq_n), .halt_n(halt_n), .a15(a15), .a14(a14),
    .a1_in(a[1]), .a0_in(a[0]), .a_out(a_out), .a_oe(a_oe), .phi_n(phi_n), .nmi_pull(nmi_pull),
    .rom_cs_n(rom_cs_n), .ram_cs_n(ram_cs_n), .sync(sync), .black(black));
  genvar i;
  generate for (i = 0; i < 8; i = i + 1) begin : dpin
    assign d[i] = d_pull[i] ? 1'b0 : 1'bz;
  end endgenerate
  assign a = a_oe ? a_out : 9'bzzzzzzzzz;
  assign nmi_n = nmi_pull ? 1'b0 : 1'bz;
  assign tv_sync_n = !sync;
  assign tv_white = !sync && !black;
endmodule
