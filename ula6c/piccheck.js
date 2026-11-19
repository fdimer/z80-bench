// ---- The picture check: a frame from the ULA's colour lines against the screen in the lower RAM ----
// frame: colour numbers (0-7, 8-15 bright; bright black is 0), w x h dots, as SpecUla.sample() collects them.
// ram: 4000h onwards (the lower RAM is ram[0..3FFF]). Finds where the 256 x 192 picture sits in the frame (the first
// time, by searching, unless the caller gives it; then it keeps that place), and counts the dots that differ from what the bitmap and attributes
// say. Cells with the flash bit are left out: which phase of the flash the ULA is in depends on when it started.
let pcPlace = null;
function pictureExpect(ram, px, py) {
  const at = ram[0x1800 + (py >> 3) * 32 + (px >> 3)];
  const bits = ram[((py & 0xC0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | (px >> 3)];
  if (at & 0x80) return -1;
  let c = bits & (0x80 >> (px & 7)) ? at & 7 : at >> 3 & 7;
  if (c && at & 0x40) c += 8;
  return c;
}
function pictureCheck(frame, w, h, ram, reset, place) {
  if (reset) pcPlace = place || null;
  if (!frame) return { found: false };
  const score = (x0, y0, step) => { let bad = 0, n = 0; for (let py = 0; py < 192; py += step) for (let px = (py * 7) % step; px < 256; px += step) { const e = pictureExpect(ram, px, py); if (e < 0) continue; n++; if (frame[(y0 + py) * w + x0 + px] !== e) bad++; } return { bad, n }; };
  if (!pcPlace) {
    let best = null;
    for (let y0 = 0; y0 + 192 <= h; y0++) for (let x0 = 0; x0 + 256 <= w; x0++) { const s = score(x0, y0, 23); if (s.n && (!best || s.bad < best.bad)) best = { x0, y0, bad: s.bad, n: s.n }; }
    if (!best || best.bad > best.n * 0.05) return { found: false, border: frame[2 * w + 40] };
    pcPlace = { x0: best.x0, y0: best.y0 };
  }
  const s = score(pcPlace.x0, pcPlace.y0, 1);
  return { found: true, x0: pcPlace.x0, y0: pcPlace.y0, bad: s.bad, n: s.n, border: frame[Math.max(0, pcPlace.y0 - 20) * w + pcPlace.x0 + 100] };
}
if (typeof module !== 'undefined') module.exports = { pictureCheck, pictureExpect };
