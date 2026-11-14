# ZX81 ULA, gate level (branch zx81-ULA)

Source: Ferranti drawing LD6532/ULA2C184/1, "ULA-2C184 Logic", issue 1, 7 April 1981 (one sheet, grid rows 1-38,
columns A-BJ). The user's machines carry the later 2C210E, whose logic diagram is not available.

Goal: a gate-for-gate description of the 2C184 that is accurate enough to build a replacement chip from.

## Files

| File | What it is |
|---|---|
| `ula/2c184.net` | The netlist, transcribed from the drawing. One line per gate, flip-flop or pin buffer, each with its grid square, so it can be checked against the drawing |
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
