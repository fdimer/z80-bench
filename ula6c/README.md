# ZX Spectrum ULA 6C001E-7, gate level (branch spectrum-ULA)

Work in progress: a gate-for-gate transcription of the Ferranti 6C001 mark 7 (the 6C001E-7 of issue 3 and later
Spectrum 48K boards), an event-driven simulation of it, and a testbench that runs it against the Spectrum emulator in
`src/spectrum.js`. Built the same way as the ZX81's 2C210 on the `zx81-ULA` branch.

Sources: Ferranti drawings from the Ferranti archive catalogued in 2026 by Happy Little Diodes
(catalogue: "Ferranti Docs" workbook, https://docs.google.com/spreadsheets/d/1_6S9HtXdFBRyo7NQ52pcOQgZlP1N_M-T):

| Archive no. | Drawing | Date | Use here |
|---|---|---|---|
| SPEC-FER-SCH-018 | LD6790/ULA6C001/1 revision 3, top-level logic, marked "MK7" in red pen (the 4 CAS delay gates and 2 ADSEL gates added on mark 7) | 10 October 1983 | The chip transcribed |
| SPEC-FER-SCH-017 | The same drawing without the red pen | 10 October 1983 | Checked against |
| SPEC-FER-SCH-014, -016, -015 | 6C001/2, /3, /4: the cells the top level draws as symbols (flip-flops, counters, latches, pin cells, oscillator, tape and colour encoder) | 1982-1983 | Cell behaviour |
| SPEC-FER-SCH-051 | "Typical System Timing (Internal Memory Request)", hand drawn | undated | RAS/CAS check |

## Terms of use and licence

**The drawings.** The archive's terms: the documents are presented only for preserving material of historical interest
and for non-commercial, educational and archival research. Consent is strictly limited to non-commercial use. Any
commercial use of the documents or their contents, including use in connection with the manufacture, marketing or sale
of goods, is prohibited by Sky UK Limited.

**What is derived from them.** The netlist (`6c001.net`), and anything generated from it (the simulation results and
any Verilog or FPGA design that follows), is a transcription of those contents, so the same terms apply: **strictly not
for commercial use of any kind**. That includes making, selling or marketing replacement chips, boards or kits built
from this work, even to repair machines. Building one for your own machine, research or teaching is the intended use.

**The code.** `sim.js`, `tb.js` and the rest of Z80 Bench are under the repository's licence, the
[PolyForm Noncommercial License 1.0.0](../LICENSE.md), which also allows noncommercial use only.

**ROMs.** The Spectrum ROM is copyrighted and is not part of this repository; the testbench reads a copy from a path you give.

The archive and how it was found are presented in the Happy Little Diodes video: https://youtu.be/jiW3P1rJRMc
If you appreciate the archive, its compiler asks that you consider supporting the Happy Little Diodes channel.

## Files

- `6c001.net`: the netlist, 385 elements (gates, flip-flops, counters, latches, pin cells, and the oscillator, tape and
  colour-encoder cells), one per line: `id type outputs inputs @grid`. Grid references are the drawing's (column
  letters, row numbers). Nets carry the drawing's pin names (`PN35_NRAS` and so on) where they reach a pin.
- `sim.js`: the event-driven simulation (`Ula6cSim`). Cell behaviours are in its header.
- `tb.js`: the testbench. `SPEC_ROM=/path/to/48.rom node ula6c/tb.js [frames]`

## How the netlist was made

The red-pen copy was scanned at 144 dpi (12000 x 8420). Gates, inverters and boxes were found by template matching,
wires traced from the line image, and the result turned into nets with rules for junction dots, crossings, the ⊗
pass-through markers and broken lines. Then it was checked by hand against the drawing, gate by gate where the
simulation disagreed. Corrections made by hand include:

- gates with an extended back whose last inputs the tracing missed (about 15 NORs);
- paper-fold creases read as wires, and the red-pen ellipses;
- N.ADEN, the address pins' enable, comes from the RTL2 inverter; RAS comes from the NOR beside RASEXT (they meet at
  the ⊗ above the RAS pin only on paper);
- the data pins D0-D4, D6 and KB0 are open-collector (R38, OC1);
- the VIDEN' latch (column W, row 10) was missed as a box, so its outline had been read as wires joining its inputs and
  outputs together; without it the picture went on into the border;
- the shift register's clock had been joined to the D2 input of its second stage across a fold in the paper;
- **one departure from the drawing:** the drawing feeds the A2 row address from the N.F line (F inverted), which
  would put half of the screen reads at the wrong address. It is taken from G, the next counter stage, which is what
  the screen layout needs. This looks like a drafting slip, but it is a guess.

## Delays

The archive has no gate delays for the 6C000 series (Table 2.1 covers the 2C000 and 5C000). Nominal values are used:
1.4 ns a NOR, 1.7 ns an inverter, 5 ns a flip-flop, 4 ns an input or output buffer. With these the RAS/CAS lines have
no glitches. The inverter is taken a little slower than the NOR for one reason: when the inhibit window ends on the
same oscillator edge that would start the CPU clock's next half, the clock gate (column AN, row 15) sees a pulse one
gate wide; with the NOR at least as fast as that pulse it passes, and then runs round the clock-stop latch for ever.
A real gate that slow to switch would not pass it.

## What the testbench checks, and where it stands

The emulator boots the ROM and runs a short test program; its bus cycles are replayed on the gate-level ULA, with the
Z80 side clocked by the ULA's own CPU clock. The board around the ULA is modelled from Timex's issue 6A diagram: the
lower RAM (4116s), the keyboard matrix, the EAR pin, the 470 ohm resistors on the data lines, TR3 (the Z80's clock is
pin 32 inverted) and TR6, an emitter follower from the CPU's A0 that holds the ULA's IORQ input high for odd ports, so
the ULA sees an I/O request only for even ones. The lower RAM keeps the last byte on the data lines for a while after
CAS rises (the lines hold their charge until something drives them), which is what the floating bus is.

T-state 0 of the frame is placed where the clock holds line up with the emulator's (the second CPU clock rise after
INT falls). With that (`SPEC_ROM=... node ula6c/tb.js 4`):

- clock holds (contention): all 73,605 bus cycles agree with the emulator, which agrees with Fuse's tests: memory
  cycles to 4000h-7FFFh held 6, 5, 4, 3, 2, 1, 0, 0 from T-state 14,335, and I/O cycles as Fuse has them (even ports
  N:1 C:3, odd ports N:4, contended high byte C:1 C:3 or C:1 C:1 C:1 C:1);
- the floating bus: every read of an odd port returns what Fuse returns (the byte the ULA is fetching 3 T-states into
  the I/O cycle, after any holds), and the same as the emulator in `src/spectrum.js`. (The emulator used to look 2
  T-states earlier; this testbench found it, and it was corrected on the `spectrum` branch.);
- 448 dots a line, 312 lines a frame (19.968 ms); INT 32 T-states once a frame; 3.5 MHz CPU clock when uncontended;
- two RAS cycles of two CAS each per fetch, as on Ferranti's timing sheet; every one of the ULA's screen reads goes to
  the address the emulator expects;
- ROM select; port FE (keyboard, EAR); every CPU read of the lower RAM through the ULA's RAS, CAS and DRAMWE;
- the picture: the colour lines into the encoder (GREEN', RED', BLUE', N.HL), dot by dot, match the emulator's picture
  in every dot of the 256 x 192 area (cells with the flash bit left out: the ULA's flash counter starts where it
  starts), 8 dots later than the emulator's. The ULA is still blanking for the first 23 dots of the emulator's 48-dot
  left border; the rest of the border agrees but for a cell around each OUT (the emulator changes it a cell at a time).

What stays open is where INT falls. Placed as above, INT falls 2.44 T-states before T-state 0. If the Z80 samples INT
at the start of an instruction's last T-state (the data sheet's rising edge), an instruction starting at T-state -1
to 30 takes the interrupt, one T-state earlier than Fuse's 0 to 31. Put the other way, relative to the interrupt this
ULA holds the CPU one T-state later than Fuse: what Spectrum timing tests call a "late timing" machine, which some real
48Ks are. It could also be the nominal delays, or the exact clock edge the Z80 samples INT on; a measurement on a real
6C001E-7 would settle it.

## The whole machine and the page

`specula.js` is a Spectrum 48K run from this ULA, closed loop: the emulator's Z80 core makes its bus cycles on the
ULA's own clock edges, so contention, the screen fetches, INT, the keyboard and the picture all come from the gates.
`piccheck.js` compares each frame from the colour lines with what the bitmap and attributes in the lower RAM say.
`SPEC_ROM=... node ula6c/runspec.js [frames] [boot|cold]` runs it; with the ROM's start-up run by the emulator and
handed over, every dot of the 256 x 192 area matches, and it runs at about 3% of a real Spectrum.

`page.src.html` is the browser test bench; `node ula6c/build_page.js` puts the scripts and the netlist into it and
writes `spectrum-ula.html`, one self-contained file. The ROM is not in it: the page asks for one.

In the frame `specula.js` collects (dots counted from the end of each line sync), the picture starts at dot 85 and
line 60. At the start of each line the colour lines carry 8 dots of black, then the border colour and black in turn
for 16 dots each (twice), then the border from dot 72: the black stretches are the left-edge difference the testbench
reports. Whether the real chip does the same is open.
