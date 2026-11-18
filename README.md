# Z80 Bench: spectrum branch (Sinclair ZX Spectrum 48K)

This branch turns Z80 Bench into a Sinclair ZX Spectrum 48K, the issue 4A/4B board, modelled from its circuit diagram: the Z80 with its pinout, bus timing, disassembly and debug points, wired to the ULA (IC1, 6C001), the ROM and the 48K of RAM. Faults on the chips are still to come. (The branch started from the CPC branch, whose files are still here.)

- **Contention**: the ULA owns the lower 16K of RAM (4000h-7FFFh). While it reads the screen (from T-state 14,335 of each 69,888 T-state frame, for 128 T-states of each of the 192 lines of the picture) a CPU cycle that uses that RAM, or an even port, or leaves such an address on the bus in an internal cycle, has its clock held 6, 5, 4, 3, 2, 1, 0 or 0 T-states. The hold is worked out at each bus access as the Z80 core logs its cycles, so every read and write happens at its true T-state. Every contention point of every instruction agrees with Fuse's Z80 test expectations (1,335 tests; the test files are not part of this repository). The held T-states show as TH in the clock-by-clock view; a Contention box turns it off.
- **Video**: 312 lines of 224 T-states. The border comes from port FE, and the bitmap and attribute bytes are read from the screen memory at the moment each cell is drawn, so changes made while the picture is drawn show. Flash every 16 frames. The interrupt is low for the first 32 T-states of each frame.
- **Port FE**: the keyboard's eight half-rows by the high byte of the address, the EAR input (bit 6, with the issue 3 and later threshold: bit 4 written reads back, bit 3 alone does not), the border, MIC and the speaker. Odd ports read the floating bus: what the ULA is fetching for the picture, or FFh.
- **Cassette**: TAP and TZX files, and WAV recordings, are played as the signal they describe into EAR, so the ROM's loader and custom loaders read them bit by bit. **Instant loading** catches LD-BYTES (0556h) and copies each block straight from the file (flag, length and checksum checked); after an instant load the tape stops by itself once nothing reads it. **Fast loading** runs at full speed while a loader is reading the tape. **Record** catches what SAVE writes to MIC, as a TAP file (or TZX of pulses) to load back or save; **Save .wav** writes the tape as sound for a real Spectrum. Tapes and snapshots can be chosen inside a .zip.
- **Snapshots**: load 48K .SNA and .Z80 (versions 1-3), save .SNA.
- **Sound**: the beeper (bit 4, a little of bit 3 and the tape signal), played in real time.
- **Keyboard**: the 40 keys drawn with their keywords, SYMBOL SHIFT symbols and extended-mode words; typed characters become the Spectrum keys that give them.
- **The ULA's pins** beside the Z80, live where they follow the CPU's bus cycle (INT, CPU CLK, the control lines, A14, A15, ROMCS, the keyboard and MIC/EAR, and the data lines for the lower RAM and port FE). Its own screen reads and video outputs are not yet followed clock by clock.

**The ROM is not included.** Load your own 48K ROM (CRC DDEE531F) with the Load ROM button; the browser keeps it. Open `z80-bench.html` from this folder. The model is `src/spectrum.js`; `node tests/spectrum-test.js` checks the timing, the ports and the tapes, and with `SPEC_ROM=/path/to/48.rom` also boots the ROM, types BASIC, loads a tape instantly and from the signal, records a SAVE and loads it back, and saves and loads a snapshot.

The rest of this file describes Z80 Bench itself.

---

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
