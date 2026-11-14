# ZX81 ULA, gate level (branch zx81-ULA)

Sources: Ferranti logic diagrams from the Ferranti archive catalogued in 2026 by Happy Little Diodes
(catalogue: "Ferranti Docs" workbook, https://docs.google.com/spreadsheets/d/1_6S9HtXdFBRyo7NQ52pcOQgZlP1N_M-T):

| Archive no. | Drawing | Chip | Date | Use here |
|---|---|---|---|---|
| ZX81-FER-SCH-102 | LD6679/ULA2C210/1, "ULA-2C210 Logic", issue 1 | 2C210 | 12 January 1982 | The chip in the ZX81s modelled here; the main target |
| ZX81-FER-SCH-011 | LD6532/ULA2C184/1, "ULA-2C184 Logic", issue 1 | 2C184 | 7 April 1981 | The earlier chip, kept for comparison |

| ZX81-FER-SCH-103 | ULA 2C158/2, "ULA 2C158" blocks, issue 4 | 2C158 | 24 September 1980 | The circuit of every cell the logic diagrams draw as a symbol: latch, T and D flip-flops, each kind of pin, the oscillator, the tape input and the three-level TV/TAPE output. Marked by hand "2C210 peripherals" |

The two logic diagrams are one sheet each on the same grid (rows 1-38, columns A-BJ) with the same layout, so a reading
on one can be checked on the other. The archive also holds the 2C158 logic diagram (ZX81-FER-SCH-105, September 1980),
not used yet. The drawings themselves are not in this repository: only the netlists transcribed from them, with grid references.

The other sources (Sinclair's ZX81 circuit diagram SRC 049 for the pinout and board, and the behaviour model in
`src/zx80.js`) are described in the main README.

## Terms of use and licence

**The drawings.** The archive's terms: the documents are presented only for preserving material of historical interest
and for non-commercial, educational and archival research. Consent is strictly limited to non-commercial use. Any
commercial use of the documents or their contents, including use in connection with the manufacture, marketing or sale
of goods, is prohibited by Sky UK Limited.

**What is derived from them.** The netlists (`2c210.net`, `2c184.net`), and anything generated from them (the
simulation results and any Verilog or FPGA design that follows), are a transcription of those contents, so the same
terms apply: **strictly not for commercial use of any kind**. That includes making, selling or marketing replacement
chips, boards or kits built from this work, even to repair machines. Building one for your own machine, research or
teaching is the intended use.

**The code.** `sim.js`, `tb.js` and the rest of Z80 Bench are under the repository's licence, the
[PolyForm Noncommercial License 1.0.0](../LICENSE.md), which also allows noncommercial use only.

**ROMs.** The ZX81 ROM is copyrighted and is not part of this repository; the testbench reads a copy from a path you give.

**Third-party designs.** The jjmz/ula-vhdl design compared below has no licence file, so it is only compared with, not
copied: none of its code is in this repository.

If you appreciate the archive, its compiler asks that you consider supporting the Happy Little Diodes channel.

Goal: a gate-for-gate description of the 2C210 accurate enough to build a replacement chip from; the 2C184 kept for
comparison.

## Files

| File | What it is |
|---|---|
| `ula/2c210.net` | The 2C210 netlist (main target). |
| `ula/2c184.net` | The 2C184 netlist, transcribed from its drawing (partial). One line per gate, flip-flop or pin buffer, each with its grid square, so it can be checked against the drawing |
| `ula/sim.js` | Event-driven simulation of the netlist, one element per gate, flip-flop or pin buffer, each with a delay (inertial: shorter pulses are swallowed) |
| `ula/tb.js` | Testbench: the emulator boots the real ROM, and its Z80 bus cycles are replayed as bus waveforms on the gate-level ULA, clocked by the ULA's own clock; what the ULA does is checked against the emulator. `ZX81_ROM=/path/to/rom node ula/tb.js [frames]` (the ROM is never copied into the repository). `ULA=gates.v` runs it on the generated Verilog read back, `ULA=sync` on the synchronous design |
| `ula/gen_verilog.js` | Writes `2c210_gates.v` from the netlist, and reads such a file back into a netlist (for the testbench) |
| `ula/2c210_gates.v` | **Generated.** The netlist as Verilog, one primitive per gate with its delay. For simulation, and to check other designs against; not for synthesis |
| `ula/2c210_sync.v` | The synchronous design for an FPGA or CPLD: one 13 MHz clock. `ula2c210_core` is the logic; `ula2c210_sync` wraps it with the chip's pins |
| `ula/v2js.js` | Runs `ula2c210_core` in the testbench by translating its (deliberately small) subset of Verilog to JavaScript |
| `ula/zx81ula.js` | **The closed loop**: a ZX81 in which nothing of the ULA is modelled. The Z80 core's bus cycles go onto the ULA's pins T-state by T-state, timed from the ULA's own clock, and the opcode the Z80 reads, NMI, WAIT, the memory selects, the font address and the picture all come back from the ULA's pins. Works with either engine |
| `ula/run81.js` | Runs it from the command line: `ZX81_ROM=/path/to/rom [KEYS="2.4:1 2.7:P"] [PGM=picture.pgm] node ula/run81.js [seconds] [sync \| net]` |

## Netlist format

    # comment
    <id>  <type>  <output net>  <input nets...>  @<grid>  [delay=<ns>] [note]

Types: `pin_in`, `pin_out`, `pin_oc` (open collector), `buf_ef` (emitter-follower input buffer), `inv`, `nor<n>`,
`or<n>`, `nor2_rtl`, `inv_rtl`, `dff` (D flip-flop: d, clock, reset), `tff` (toggle: clock, reset; outputs Q and Q-bar),
`dlatch` (d, enable; an output named NQ.. is the inverted one), `osc`, `pin_ts` (tri-state: data, enable), `pin_tp`
(push-pull), `pin_tpn` (inverting push-pull), `out3` (the 3-level TV/TAPE output). Inputs written `~net` are inverting
inputs (a circle on the drawing); flip-flops act on the rising edge of the clock input as written; resets are active high;
`-` = not connected.
Nets are named after the drawing where it names them (S/L, D6L, LINE-SYNC, FRAME-SYNC, Q1..Q31, NQ11..NQ18);
other nets are named after the grid square of the gate that drives them, so `n_23T` is driven by the gate in row 23, column T.

## Status

`2c210.net` is complete: every entry is checked against the drawing (`ok210`). Two polarities are not on the logic
diagram, which says "see cct diagram". They were first settled by what makes the chip work, and the cell circuits
(ULA 2C158/2) then confirmed both:
- the ROM CS and RAM CS cells: an input transistor, then a stage that inverts (`inv_rtl` then `pin_tpn`), so the cell
  as a whole does not invert, and the RAM cell holds the ROM cell off;
- the clock output cell does not invert, so the Z80's CLK (through TR2) is in phase with Q19. The character latch's
  last window is then after CLK falls in T2, and FORCE holds the NOP across the T3 rise.

The same sheet confirms the conventions used for the symbols: the data latch is open while its clock is low; the T
and D flip-flops act on the falling edge of their clock pin and have an active-high reset; and on TV/TAPE, sync wins,
then N.VIDEO high is black.

Readings corrected while closing the trace: the character fetch decodes D6 (not M1); Q17 latches CHAR, not D6; the
NOP drive (FORCE) is LK2 = NOR(LCLKn, N.M1, NOT CHAR); EN = NOT INFE; the address enable takes D6L, not S/L, so the
ULA drives A0'-A8' from the end of a character's M1 to the next M1; S/L takes Q19n; the row counter is clocked by SYNCn.

Testbench result (16K ZX81, real ROM, a screen of normal and inverse characters, Q held down for a while; compared from
the ULA's first vertical sync, as it powers up in an arbitrary state), 4 frames: every opcode fetch gives the Z80 the
same byte as the emulator (the NOP for all characters), every refresh after a character puts the same font address on
A0'-A8' with the ROM selected, the row counter agrees, ROM and RAM selects agree on every read and write, port reads
(keyboard included) agree, vertical sync starts and ends within 3 T-states of the emulator, and the video output matches
the emulator's dots exactly with no offset.

The gate level corrected two of the emulator's constants (its logic was right): the sync, and so the NMI, starts 20
T-states after the interrupt acknowledge begins, not 13, and lasts 16 T-states, not 20 (`ULA_HSYNC_DELAY` and
`ULA_HSYNC_LEN` in `src/zx80.js`). With them the NMIs agree to within 0.2 of a T-state.

## Closed loop

With the ULA in charge (`zx81ula.js`), the real ROM boots a 16K ZX81 to the cursor on both engines, the display runs
at 50 frames a second in SLOW mode with its NMIs, interrupts and wait states, and typing P puts PRINT on the screen.
Up to the first NMI (213,000 instructions) the Z80 runs instruction for instruction as in the hybrid emulator; after
that the two differ only in where the NMIs fall. Over the first 0.75 s the netlist and the synchronous design give the
same frames, NMIs, interrupts, wait states and program counter.

Speed, in this general-purpose harness: the synchronous design runs about 22 times slower than a real ZX81, the
netlist about 90 times. Not modelled yet: the tape, and a RAM pack's own decoding (the RAM is one block on RAM CS).

## Verilog

**`2c210_gates.v`** is the drawing in Verilog: 189 gates, flip-flops and pin drivers, with the same delays as `sim.js` (estimates, not Ferranti's
figures). Like the chip it makes its latch, load and reset pulses from gate delays, so it is for a simulator. Read back
into a netlist and run through the testbench (`ULA=gates.v`), it gives the same result as the netlist it came from.

**`2c210_sync.v`** does the same job with one clock, 13 MHz (twice the ZX81's 6.5 MHz), so a T-state is four clock
periods (`ph` 0-3; the Z80's clock is high in 0 and 1):

| In the chip | Made from | In the synchronous design |
|---|---|---|
| Character latch open (LCLK) | Q19 low and OSC high, during M1 | taken on the edge that ends `ph` 2 |
| NOP on the data lines (FORCE) | M1, a character, latch closed | the same, combinational |
| Shift register load (S/L) | a 35 ns pulse after Q19 rises, if MREQ is high | the edge that starts `ph` 0 |
| Dot clock | OSC rising | the edges that start `ph` 0 and `ph` 2 |
| Line counter | ripple counter on Q19 falling, cleared at 207 or by INT acknowledge | 0-206 on the edge that starts `ph` 2 |
| NMI and frame-sync latches, Q20 | cross-coupled gates and a flip-flop clocked by MREQ | registers, set on the next clock edge (at most 77 ns later) |
| Memory selects, keyboard port, address enable | combinational | combinational |

Through the testbench (`ULA=sync`) it matches the emulator on everything the gate level does: NOPs, font addresses,
selects, port reads, row counter, vertical sync and every dot. Its NMI and sync come about 95 ns (0.3 of a T-state)
earlier than the gate-level model's, because the ripple counter's delay is gone.

**How far this is checked.** Both files compile in Yosys 0.71 (the gates file once its `pullup` primitives, which
Yosys does not know, are taken out; they are standard Verilog). Three runs of the testbench stand behind them:
- `ULA=gates.v`: the gates file read back into a netlist and run in `sim.js`. It checks what the file says, gate by
  gate, but not a simulator's own reading of the primitives.
- `ULA=sync`: `v2js.js` executing the text of `ula2c210_core`.
- `ULA=yosys`: the same core after Yosys has synthesized it to 192 gates and 35 flip-flops (the command is in
  `v2js.js`), so it rests on a real compiler's reading of the Verilog. Same result: no differences.

Not done: the pin wrapper `ula2c210_sync` (tri-state and open-drain pins) compiles but has not been simulated; the
gates file has not been run in an event-driven Verilog simulator (Icarus Verilog would do it); and nothing has been
placed and routed for a real FPGA, so there are no timing figures.

## Electrical requirements for a replacement

What a board that plugs into the ULA's 40-pin socket has to do, from the drawing's pin circuits and Sinclair's circuit
diagram. The logic above is the easy part.

| Pins | Signal | In the chip | A replacement needs |
|---|---|---|---|
| 40, 34 | +5 V, 0 V | bipolar, runs hot | its own regulator if the logic is 3.3 V |
| 32, 30, 28, 26, 24, 23, 21, 19 | D0-D7 | input with 16K pull-up; open-collector pull-down | 5 V tolerant inputs; outputs that only ever pull low. They work against the 470 ohm resistors to the memory's data lines, so they must sink about 10 mA and reach a good low |
| 33, 31, 29, 27, 25 | KBD0-KBD4 | inputs, 16K pull-ups | pull-ups to +5 V: the keyboard has none of its own |
| 22 | USA/UK | input, 16K pull-up | pull-up (the link, when fitted, grounds it) |
| 20 | TAPE IN | 400 ohm series, clamp diodes, a biased two-transistor input stage (circuit on ULA 2C158/2) | an input stage that turns the tape's small signal into logic: a comparator or the same network, not a bare FPGA pin |
| 35 | OSC | on-chip oscillator with the board's 6.5 MHz ceramic resonator | its own 13 MHz oscillator (or 6.5 MHz and a doubler); pin 35 left unconnected |
| 9, 10, 6, 8, 7, 17, 18, 11 | MREQ, M1, RD, WR, IORQ, HALT, A15, A14 | inputs, 16K pull-ups | 5 V tolerant inputs |
| 5, 4, 3, 36, 37, 38, 39, 1, 2 | A0'-A8' | tri-state outputs; A0' and A1' also read | tri-state outputs that win against the Z80 through the 1K resistors (5 mA), released within a few tens of ns of M1 falling; A0' and A1' are inputs too |
| 14 | clock out | totem-pole output to TR2 | a 5 V swing into TR2's base resistor |
| 15 | NMI | open collector, 5K pull-up on chip | open-drain output with a pull-up to +5 V |
| 13, 12 | ROM CS, RAM CS | RTL stages, totem-pole outputs | 5 V-level outputs; RAM CS feeds the RAM through 680 ohms on the board |
| 16 | TV/TAPE | one pin with three levels, from an emitter follower with 200 ohms in series and 1K to 0 V (circuit on ULA 2C158/2): sync 0 V, black about 2.8 V, white about 4.3 V unloaded (calculated from the resistor values, not measured) | two outputs (`tv_sync_n`, `tv_white`) mixed by resistors to those three levels; worth checking against a working machine. The same pin is the tape output |

Timing a replacement must keep: the NOP must be on D0-D5 and D7 before the Z80 reads at the start of T3 and until M1
rises; the font byte is taken as the next T-state starts, so the ROM must stay selected and A0'-A8' driven until then;
and the selects must follow MREQ and A14 without waiting for a clock.

The start-up state is whatever the registers power up as; like the chip, the design has no reset pin, and the ROM's
first OUT instructions put it in order.

## Comparison with other replacements

`reference/jjmz-ula-vhdl` (github.com/jjmz/ula-vhdl, commit e450266, 6 March 2026; VHDL for a Xilinx XC9572XL CPLD).
The repository has no licence file, so its code is kept in the OneDrive reference folder only and is not copied here.
It is a synchronous design: a 26 MHz master clock divided by 4 for the 6.5 MHz dot clock and by 8 for the Z80's
3.25 MHz, and a state machine at 6.5 MHz (Tstate) where the Ferranti chips use gate-delay chains.

Agrees with the drawings: line counter 0-206 (207 counts), re-phased by the interrupt acknowledge; line sync at
counts 16-31; NMI = line sync AND an NMI-on latch (set by OUT with A0 low, cleared by OUT with A1 low); vertical sync
set by IN with A0 low while the NMI is off and cleared by any OUT; the character fetch decoded from A15, HALT and MREQ,
abandoned when the byte has D6 high; A0'-A2' from a 3-bit row counter and A3'-A8' from the latched character bits
0-5; the inverse-video bit is D7.

Agrees too: the row counter steps on line sync and is held clear by vertical sync.

Differs from the 2C210:
- ROM select from A15-A13 all low; the 2C210 uses A14 and Q20.
- D5 driven low on a keyboard read; the 2C210 does not drive D5 (it reads high through the board's pull-up).
- Blanking: it shows black for counts 32-63 (a back porch); the 2C210's new blanking gate decodes counts 16-31 (the
  sync period) with its edges moved by three gate delays.
- Inverse video applied when the byte is loaded into the shift register; the 2C210 applies it at the output through Q32.
- WAIT is made inside (on the ZX81 board it is transistor TR1), plus extras the original lacks: a configuration
  register (POKE 67,89 then POKE 66,n), faster clocks, inverse options and a reset trap.
