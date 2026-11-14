# Z80 Bench

A Z80 CPU emulator for debugging programs and designing hardware around the chip. It runs in a web browser and shows the state of all 40 pins on every T-state.

**Try it online:** <https://fdimer.github.io/z80-bench/app/>

Open `z80-bench.html` in any web browser, from this folder on your computer (it loads the CPU core and assembler from `src/`). It needs no installation or internet connection; the web fonts fall back to system fonts offline.

To get a single self-contained file instead, run `python build.py`, which writes `z80-bench-standalone.html`.

## Features

- **Pinout**: 40-pin DIP view that updates every T-state (high, low, or floating). Click the input pins to drive them:
  - CLK pulses one clock
  - /INT is level-sensitive and honours EI/DI and IM 0/1/2
  - /NMI triggers on a falling edge
  - /WAIT inserts wait states at the correct sampling point
  - /BUSREQ floats the buses at the end of the machine cycle and asserts /BUSACK
  - /RESET holds the CPU in reset and restarts at 0000h
- **Program input**: switch between Assembly and Hex.
  - Assembly: standard Zilog syntax, labels, ORG, EQU, DB, DW, DS, END, expressions, and the undocumented instructions.
  - Hex: bytes with optional `ADDR:` jumps, or Intel HEX.
  - **Import file…** (or drop a file on the editor): `.asm`/`.z80`/`.s` go to Assembly; `.hex`/`.ihx` and plain hex text go to Hex; raw `.bin`/`.rom` images are converted to hex.
  - **Load at** sets where code goes in memory, e.g. the start of ROM in your memory map. In Assembly it applies until the first `ORG`; Intel HEX keeps its own addresses.
  - "Copy bytes to Hex tab" turns assembled code into an annotated hex listing.
- **Memory**: 1–64 KB installed. Above the top, reads return FFh or mirror the installed memory. Bytes are editable in the memory view.
- **Stepping**: one T-state, one instruction, or run at 5 Hz, 50 Hz, 1 kHz, 5 kHz, 10 kHz or full speed.
- **Breakpoints**: click a line in the disassembly to cycle between *break at* (filled dot: stops before the instruction runs), *break after* (ring: stops when the PC leaves that address, so an instruction that repeats in place, such as LDIR or a jump to itself, runs to completion first) and off.
- **Register stops**: click **stop** beside any register and give a hex value; the run halts at the end of the instruction that changes the register to that value, in every run mode.
- **Debug pane**: lists every breakpoint and stop, with a × to remove each and a click to jump to it. From it you can also add:
  - *memory stops*: halt after the instruction that changes the byte at an address, or changes it to a given value
  - *pin stops*: halt on the clock where a pin changes, goes high or goes low (while one is set, full speed runs clock by clock, so it is slower)
  - *bus stops*: halt on the clock where the address bus or data bus takes a given value (like pin stops, these slow full speed while set)
- **Bus timing**: waveform of /M1 /MREQ /IORQ /RD /WR /RFSH, plus address and data, for the current instruction.
- **I/O**: OUT writes are shown as 8-LED latches with a log. You can set the value IN returns for each port.

## Sinclair ZX80 / ZX81 (this branch)

`src/zx80.js` emulates the ZX80 (4K ROM), the ZX80 with the 8K ROM, and the ZX81, with 1K, 2K (Timex Sinclair 1000) or 16K–48K of RAM. The page built from it (see `zx80web` on the site) adds the TV picture, the keyboard, tape files and these hardware views:

- **Memory chips**: the ROM and RAM chips with live pins.
- **Processor and ULA** (ZX81): the ULA (IC1) drawn beside the Z80 with live pins, clock by clock. Its pinout is from Sinclair's circuit diagram SRC 049; Ferranti published no data sheet, so its inside is a model of its behaviour. The `zx81-ULA` branch has a gate-level netlist of the 2C210 transcribed from Ferranti's logic diagram, with a simulator that checks this model against it; see `ula/README.md` there for its sources and its non-commercial terms.
- **Faults**, two kinds, as on the CPC branch: a **line held high or low** (every pin on that line, on every chip, sees it) and a **pin disconnected from its line** (only that chip is affected). The ZX81's lines follow the diagram: A0'–A8' and D0'–D7' on the memory side of the 1K and 470 ohm resistors, D0–D7 between the Z80 and the ULA, the control lines, NMI, the clock, ROMCS and RAMCS, and the Z80's INT pin on A6. On the ZX80 and the RAM pack's chips every pin counts as a line of its own.

`tests/zx80-test.js` checks the video logic with a synthetic ROM (no Sinclair code) and the lines and faults (`node tests/zx80-test.js`). The ROMs are not included.

## Files

| Path | What it is |
|---|---|
| `z80-bench.html` | The application: layout, pin model, T-state engine and panels; loads the two files in `src/` |
| `src/z80core.js` | CPU core: all instructions incl. CB/ED/DD/FD/DDCB, interrupts, HALT, per-machine-cycle bus log; disassembler |
| `src/z80asm.js` | Two-pass assembler; its opcode table is generated from the disassembler |
| `build.py` | Writes `z80-bench-standalone.html`, one file with everything inlined (`python build.py`) |
| `tests/zexdoc-run.js` | Runs the zexdoc exerciser (`node tests/zexdoc-run.js zexdoc.com`); `zexdoc.com` is not included, get it from the original ZEXALL distribution |
| `tests/timing-test.js` | Checks instruction T-state counts against the datasheet |
| `tests/asm-test.js` | Round-trips all 1,136 instruction forms through the assembler |
| `src/memchips.js` | Memory chip pinouts and pin faults |
| `src/zx80.js` | The ZX80 / ZX81 machine: memory, video logic, the ULA, lines and faults |
| `tests/zx80-test.js` | ZX80 / ZX81 checks |

## Verification

- **zexdoc**: all 67 groups pass, so documented flags are correct.
- **T-states**: 49 representative instructions and interrupt responses match the Zilog datasheet.
- **Assembler**: all 1,136 instruction forms assemble to the expected bytes.

## Known limitations

- During clock stepping, registers and memory update together at the end of each instruction, not partway through it.
- In IM 0, the interrupting device can only supply an RST opcode.
- Undocumented flag bits 3 and 5 are approximate for BIT n,(HL) and the block I/O instructions.
- Peripherals (memory-mapped devices, UART, PIO, etc.) are planned next.

## Running the tests

The tests need [Node.js](https://nodejs.org/):

```
node tests/timing-test.js
node tests/asm-test.js
node tests/zexdoc-run.js path/to/zexdoc.com
```

## Licence

Z80 Bench is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md). You may use, copy, modify and share it for any noncommercial purpose, including personal projects, education and research. Commercial use needs separate permission from the copyright holder. See [NOTICE](NOTICE).
