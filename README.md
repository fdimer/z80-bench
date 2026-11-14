# Z80 Bench: CPC branch (Amstrad CPC 464)

This branch turns Z80 Bench into an Amstrad CPC 464, modelled from the CPC 464 circuit diagram: the Z80 with its pinout, bus timing, disassembly and debug points, wired to the gate array, the 6845 and the memory. It is work in progress: there is no sound or cassette yet.

- **Processor timing**: the gate array's READY line (the Z80's WAIT) is high one clock in four, so every memory, I/O and interrupt cycle is stretched until it lines up; instructions take whole microseconds, as on the real machine. The wait states show in the clock-by-clock view.
- **Memory**: the 32K ROM (IC103: firmware and BASIC) over 64K of RAM, with the gate array's two ROM enable bits; writes always reach the RAM. The eight 4164s (IC117-IC124) sit behind the 74LS153 address selectors as wired on the board.
- **Video**: the 6845 (IC108) counts characters, rows and scan lines; the gate array (IC116) turns two bytes of RAM into dots for each character in modes 0, 1 and 2, with border, blanking and a mode change at HSYNC. A monitor model follows the sync pulses, so the picture rolls or tears when one is missing.
- **Interrupts**: the gate array's counter, driven by HSYNC: 300 a second, resynchronised by VSYNC.
- **Chips and faults**: the Z80, the gate array (40010 or 40007 pin arrangement) and the 6845 side by side with live pins, clock by clock, and the ROM and RAM chips in a panel of their own. Every pin that matters has a fault menu, with two kinds of fault kept apart:
  - **a line held high or low** (a short on the wire): every pin on that line, on every chip, sees the level and shows it. The bench knows which pins share each line: the address and data buses, the control lines, RESET, the clocks, the sync lines, the RAM chips' shared address, RAS, CAS and write-enable lines, and each RAM data output with its gate array data pin;
  - **a pin disconnected from its line** (a broken trace, a lifted pin): only that chip is affected. A disconnected input floats high or takes a level of its own; a disconnected output no longer drives its line. A disconnected pin ignores a fault on the line.
- **RESET** is one line for the Z80, the gate array, the 6845 and the 8255: held low they all stay in reset while the clocks run.
- **Clock and READY faults**: without the 16 MHz clock the gate array and everything it times stop; without PHI, or with READY held low, the Z80 is held while the picture goes on; without CCLK the 6845 stands still. READY held high removes the wait states; what RAM accesses then return is an approximation.
- **Keyboard**: the CPC matrix through the 8255 and the sound chip's port; typed characters are translated to the CPC key that produces them, and there is an on-screen keyboard.

**ROMs are not included.** Load your own firmware (`OS_464.ROM`, CRC 815752DF) and BASIC 1.0 (`BASIC_1.0.ROM`, CRC 7D9A3BAC) with the Load ROM button; the browser keeps them. Open `z80-bench.html` from this folder. The model is `src/cpc.js`; `node tests/cpc-test.js` checks timing, memory, faults and interrupts, and with `CPC_ROMS=/folder` also boots the real ROMs.

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
