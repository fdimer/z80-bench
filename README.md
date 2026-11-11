# Z80 Bench: MSX branch (Sony HB-55P / HB-75P)

This branch turns Z80 Bench into an MSX1 computer: the Z80 with its pinout, bus timing, disassembly and debug points, wired to the three MSX support chips.

- **Machines**: Sony HB-55P (16K RAM at C000h in slot 0) and HB-75P (64K RAM in slot 2). Slots are switched by PPI port A, as on the real machine.
- **Video**: TMS9929A with its own 16K of video RAM, all four screen modes, sprites (four per line, fifth-sprite and collision flags), 50 frame interrupts a second. The picture is drawn line by line as the CPU runs.
- **Keyboard**: the international MSX matrix, from the PC keyboard by key position or the on-screen keyboard.
- **Cartridges** in slot 1: plain ROMs and the Konami, Konami SCC, ASCII 8K and ASCII 16K mega-ROM mappers.
- **Debugging**: memory bitmap of the ROMs, RAM and video RAM tinted by use (BASIC's areas, the VDP's tables), an MSX hardware panel (slots, VDP registers, PPI, sound chip registers), RAM and video RAM dumps, and a text listing with the system variables and the BASIC program.
- **Not yet**: sound output and cassette.

**ROMs are not included.** Load your own 32 KB BIOS (`hb-55p_basicbios1.rom`) and, optionally, the 16 KB Personal Data Bank firmware (`hb-55p_firmware.rom`) with the Load ROM button; the browser keeps them. Open `z80-bench.html` from this folder. The model is `src/msx.js`; `node tests/msx-test.js` checks it with a small synthetic program.

The rest of this file describes the Z80 Bench base.

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
