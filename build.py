# Builds z80-bench-standalone.html: one self-contained file with the CPU core and
# assembler inlined (handy for emailing or opening without the src/ folder).
# Usage: python build.py
import pathlib
here = pathlib.Path(__file__).parent
page = (here / 'z80-bench.html').read_text(encoding='utf-8')
for name in ('z80core.js', 'z80asm.js', 'm6821.js', 'z80sio.js', 'wd1793.js', 'memchips.js', 'osborne.js'):
    tag = f'<script src="src/{name}"></script>'
    assert tag in page, tag
    page = page.replace(tag, '<script>\n' + (here / 'src' / name).read_text(encoding='utf-8') + '</script>')
(here / 'z80-bench-standalone.html').write_text(page, encoding='utf-8')
print('wrote z80-bench-standalone.html,', len(page), 'bytes')
