# ZX81 ULA, gate level (branch zx81-ULA)

Sources: Ferranti drawings LD6679/ULA2C210/1, "ULA-2C210 Logic", issue 1, 12 January 1982 (the chip in the user's
machines; the main target) and LD6532/ULA2C184/1, "ULA-2C184 Logic", issue 1, 7 April 1981 (the earlier chip). Both are
one sheet on the same grid (rows 1-38, columns A-BJ) with the same layout, so a reading on one can be checked on the other.

Goal: a gate-for-gate description of the 2C210 accurate enough to build a replacement chip from; the 2C184 kept for
comparison.

## Files

| File | What it is |
|---|---|
| `ula/2c210.net` | The 2C210 netlist (main target). |
| `ula/2c184.net` | The 2C184 netlist, transcribed from its drawing (partial). One line per gate, flip-flop or pin buffer, each with its grid square, so it can be checked against the drawing |
| (to come) `ula/sim.js` | Event-driven simulation of the netlist with a delay per gate, for the emulator and for checking |
| (to come) `ula/2c184.v` | Verilog generated from the netlist: a timed model, and a synchronous version for an FPGA or CPLD |

## Netlist format

    # comment
    <id>  <type>  <output net>  <input nets...>  @<grid>  [delay=<ns>] [note]

Types: `pin_in`, `pin_out`, `pin_oc` (open collector), `buf_ef` (emitter-follower input buffer), `inv`, `nor<n>`,
`or<n>`, `nand<n>`, `and<n>`, `dff` (D flip-flop: d, clock, reset), `tff` (toggle: clock, reset), `osc`, `tri3`
(the 3-level TV/TAPE output). Inputs written `~net` are inverting inputs (a circle on the drawing).
Nets are named after the drawing where it names them (S/L, D6L, LINE-SYNC, FRAME-SYNC, Q1..Q31, NQ11..NQ18);
other nets are named after the grid square of the gate that drives them, so `n_23T` is driven by the gate in row 23, column T.

## Status

Transcription in progress. Readings that are not certain are marked `?` and listed at the end of the netlist.

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

Differs from the 2C210 (to be confirmed as the trace finishes):
- ROM select from A15-A13 all low; the 2C210 uses A14 and Q20.
- D5 driven low on a keyboard read; the 2C210 does not drive D5 (it reads high through the board's pull-up).
- Blanking: it shows black for counts 32-63 (a back porch); the 2C210's new blanking gate decodes counts 16-31 (the
  sync period) with its edges moved by three gate delays.
- Inverse video applied when the byte is loaded into the shift register; the 2C210 applies it at the output through Q32.
- The row counter steps on line sync and clears on vertical sync; the 2C210's row counter clock is still being traced.
- WAIT is made inside (on the ZX81 board it is transistor TR1), plus extras the original lacks: a configuration
  register (POKE 67,89 then POKE 66,n), faster clocks, inverse options and a reset trap.
