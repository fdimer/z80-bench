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
| `ula/sim.js` | Event-driven simulation of the netlist, one element per gate, flip-flop or pin buffer, each with a delay (inertial: shorter pulses are swallowed) |
| `ula/tb.js` | Testbench: the emulator boots the real ROM, and its Z80 bus cycles are replayed as bus waveforms on the gate-level ULA, clocked by the ULA's own clock; what the ULA does is checked against the emulator. `ZX81_ROM=/path/to/rom node ula/tb.js [frames]` (the ROM is never copied into the repository) |
| (to come) `ula/2c184.v` | Verilog generated from the netlist: a timed model, and a synchronous version for an FPGA or CPLD |

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

`2c210.net` is complete: every entry is checked against the drawing (`ok210`). Two things are not on the drawing and were
settled by what makes the chip work:
- the output stages of RAM N.CS and ROM N.CS (an RTL circuit on a separate "cct diagram") invert (`pin_tpn`);
- the clock output does not, so the Z80's CLK (through TR2) is in phase with Q19. With the other phase the character
  latch closes in a race with MREQ at the T3 rise; with this one its last window is after CLK falls in T2, and FORCE
  holds the NOP across the T3 rise.

Readings corrected while closing the trace: the character fetch decodes D6 (not M1); Q17 latches CHAR, not D6; the
NOP drive (FORCE) is LK2 = NOR(LCLKn, N.M1, NOT CHAR); EN = NOT INFE; the address enable takes D6L, not S/L, so the
ULA drives A0'-A8' from the end of a character's M1 to the next M1; S/L takes Q19n; the row counter is clocked by SYNCn.

Testbench result (16K ZX81, real ROM, a screen of normal and inverse characters, Q held down for a while; compared from
the ULA's first vertical sync, as it powers up in an arbitrary state), 4 frames: every opcode fetch gives the Z80 the
same byte as the emulator (the NOP for all characters), every refresh after a character puts the same font address on
A0'-A8' with the ROM selected, the row counter agrees, ROM and RAM selects agree on every read and write, port reads
(keyboard included) agree, vertical sync starts and ends within 3 T-states of the emulator, and the video output matches
the emulator's dots exactly with no offset.

What the gate level says the emulator has slightly wrong (its constants, not its logic): the NMI arrives 6.8 T-states
later than the emulator's HSYNC_DELAY puts it, and the line sync lasts 16 T-states, not 20.

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
