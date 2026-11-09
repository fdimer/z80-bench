# Z80 Bench

A Z80 CPU emulator for debugging programs and designing hardware around the chip. It runs in a web browser and shows the state of all 40 pins on every T-state.

**Try it online:** <https://fdimer.github.io/z80-bench/app/>

Open `z80-bench.html` in any web browser, from this folder on your computer (it loads the CPU core and assembler from `src/`). It needs no installation or internet connection; the web fonts fall back to system fonts offline.

To get a single self-contained file instead, run `python build.py`, which writes `z80-bench-standalone.html`.


## Osborne Executive (osborne branch)

This branch turns Z80 Bench into an Osborne Executive emulator, working from the OCC2 main logic board schematic (1K00035 rev 10), the Osborne Executive Technical Manual and MAME's `osbexec` driver.

- `src/osborne.js` models the machine:
  - the 3.9936 MHz Z80A
  - 128K of banked DRAM, the boot ROM, font RAM and scratch RAM, all selected by the system PIA's port A
  - video RAM (C000h–DFFFh) with its attribute latch
  - the keyboard matrix on port 14h (rows selected by A8–A15)
  - the VBLANK interrupt into PIA CB1, the RTC counter, the video-enable flip-flop
  - mode 2 interrupts with the FEh pull-up vector
- `src/m6821.js` is a reusable MC6821 PIA model. The Z80 SIO comes from the `sio` branch.
- The 8253 timer, MB8877 disk controller and IEEE-488 port are stubbed, so the ROM's self-test passes and it shows its sign-on screen. Disk booting is not emulated yet.
- **The ROM is not included** (it is copyrighted). Supply your own `execv12` image (CRC 70798C2F).
- Run it headless with `node tests/osborne-run.js path/to/rom.bin [seconds] [keys...]`.

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
