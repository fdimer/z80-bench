// ---- Builds the test bench page: ula6c/spectrum-ula.html, one self-contained file ----
//   node ula6c/build_page.js [body-only output path]
// page.src.html is the page; this puts the scripts it names into it, with the netlist. The optional second file is the
// same page without the document wrapper (for a preview host).
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const here = f => path.join(__dirname, f), read = f => fs.readFileSync(here(f), 'utf8');
let ver = 'unknown'; try { ver = execSync('git log -1 --format=%h\\ %cs', { cwd: __dirname }).toString().trim(); } catch (e) {}
let page = read('page.src.html').replace(/\/\*INCLUDE:([^*]+)\*\//g, (_, f) => { const s = read(f); if (s.includes('</script')) throw new Error(f + ' contains a script end tag'); return '\n' + s; })
  .replace('/*NET*/', () => JSON.stringify(read('6c001.net'))).replace('__VERSION__', ver);
const cut = page.indexOf('</style>') + 8;      // the title, fonts and style go in the head of the standalone page
fs.writeFileSync(here('spectrum-ula.html'), '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="description" content="A ZX Spectrum 48K run from the gate-level logic of its Ferranti ULA (6C001E-7), for testing the ULA against real programs. Non-commercial use only.">\n'
  + page.slice(0, cut) + '\n</head>\n<body style="margin:0">\n' + page.slice(cut) + '</body>\n</html>\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], page);
console.log('wrote ula6c/spectrum-ula.html,', page.length, 'bytes; design version', ver);
