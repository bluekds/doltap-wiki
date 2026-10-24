import sys
import os
D = os.path.dirname(os.path.abspath(__file__)) + '/'
s = open(D + 'showreel-v1m.html').read()
def rep(old, new, count=1):
    global s
    c = s.count(old)
    if c != count: sys.exit('count %d != %d for: %s' % (c, count, old[:100]))
    s = s.replace(old, new)

rep('<title>Doltap Wiki Showreel</title>', '<title>Doltap Wiki Showreel v3</title>')
rep("   window.renderFrame(i) draws frame i (0..449). t = i / 30.",
    "   v3 = v1m (beat-nudged v1) + a 45-frame opening title card: 495 frames = 16.5 s.\n"
    "   window.renderFrame(i) draws output frame i (0..494); the story runs on i - OPEN, so every v1m\n"
    "   timing is unchanged and shifted by exactly 3 beats (45 frames at 120 BPM).")
rep("const W = 1920, H = 1080, FPS = 30, NF = 450;", "const W = 1920, H = 1080, FPS = 30, NF = 495, OPEN = 45;")
rep("""function renderFrame(i) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);""", """function renderFrame(i0) {
  const i = i0 - OPEN;                                 // story frame (negative during the opening card)
  ctx.setTransform(1, 0, 0, 1, 0, 0);""")
rep("""  act.forEach(s => s.draw(i, 'ui'));
  drawVignette(); drawGrain(i);
}""", """  act.forEach(s => s.draw(i, 'ui'));
  drawOpening(i0);
  drawVignette(); drawGrain(i);
}""")
rep("""/* =====================================================================
   frame renderer""", r"""/* =====================================================================
   v3 OPENING TITLE CARD (output frames 0..~52, screen space)
   Logo cairn stacks in on 16ths (3, 7, 11, 15), title rises (fully readable 14..41 = 0.9 s), then the
   stones lift and scatter toward the three S1 machines (36..48) while the machines fade in underneath:
   "the cairn exists -> but each machine starts from zero". Green # stone flies off, unshared.
   ===================================================================== */
const OS = 300 / 512, OX0 = 960 - 256 * OS, OY0 = 200;
const OPEN_STONES = LOGO.stones.map((s, j) => ({ ...s, x: OX0 + s.cx * OS, y: OY0 + s.cy * OS, W: s.w * OS, H: s.h * OS, land: [3, 7, 11, 15][j] }));
const SCATTER = [[400, 470], [1520, 470], [960, 430], [1260, -90]];   // grey -> mac-mini, grey -> claude.ai, tan -> linux-box, # -> away
const OT = { titleAt: 1, titleStep: 1.0, subAt: 7, scatter: 36, titleOut: [41, 46] };
function drawOpening(i) {
  if (i >= 54) return;
  ctx.save();
  glow(960, OY0 + 150, 320, C.green, .11 * seg(i, 10, 20) * (1 - seg(i, 36, 46)));
  OPEN_STONES.forEach((L, j) => {
    const drop = seg(i, L.land - 6, L.land); if (drop <= 0) return;
    let x = L.x, y = L.y - 80 * (1 - easeInQuad(drop)), sx = 1, sy = 1, rot = L.rot, a = Math.min(1, drop * 3), sc = 1;
    if (drop < 1) { sy = 1 + .1 * drop; sx = 1 - .07 * drop; } else { const q = squashAt(i - L.land, L.hash ? .14 : .1); sx = 1 + q; sy = 1 - q; }
    const st = OT.scatter + j * .8, u = seg(i, st, st + 12);
    if (u <= 0 && i >= st - 3) { const d = Math.sin(Math.PI * seg(i, st - 3, st)); y += 7 * d; sx *= 1 + .05 * d; sy *= 1 - .05 * d; }   // anticipation dip
    if (u > 0) {
      const [tx, ty] = SCATTER[j], e = easeOutBack(u, 1.3), cx = lerp(L.x, tx, .5), cy = Math.min(L.y, ty) - 150;
      x = (1 - e) * (1 - e) * L.x + 2 * e * (1 - e) * cx + e * e * tx; y = (1 - e) * (1 - e) * L.y + 2 * e * (1 - e) * cy + e * e * ty;
      sc = lerp(1, .4, easeOutCubic(u)); rot += (j % 2 ? 1 : -1) * .75 * easeOutCubic(u); a = 1 - easeInCubic(seg(u, .3, 1));
      if (L.hash) glow(x, y, 70, C.green, .45 * (1 - u));
    }
    if (a <= 0) return;
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(x, y + L.H / 2 * sc); ctx.rotate(rot); ctx.scale(sx * sc, sy * sc); ctx.translate(0, -L.H / 2);
    stoneBody(superPts(L.W, L.H, L.nT, L.nB, L.seed, .35), L.W, L.H, L.color, { shade: .6, shadow: u > 0 ? 0 : .55, glow: L.hash ? .3 : 0, seed: L.seed });
    if (L.hash) { const hp = easeOutBack(seg(i, L.land, L.land + 6), 2.4); ctx.save(); ctx.scale(OS * hp, OS * hp); ctx.rotate(-L.rot); hashGlyph(clamp(hp)); ctx.restore(); }
    ctx.restore();
    const age = i - L.land;                                           // small placement puffs
    if (age >= 0 && age < 14 && u <= 0) { const r = rng(700 + j); for (let k = 0; k < 6; k++) { const side = k % 2 ? 1 : -1, sp = 2 + r() * 4, sz = 3 + r() * 4, d = sp * (1 - Math.exp(-age * .2)) / .2;
      softDot(L.x + side * (L.W * .42 + d), L.y + L.H / 2 - 4 - d * .3, sz * (1 + age / 10), C.hi, .35 * (1 - age / 14)); } }
  });
  drawOpenTitle(i);
  ctx.restore();
}
function drawOpenTitle(i) {
  const ex = seg(i, OT.titleOut[0], OT.titleOut[1]); if (ex >= 1) return;
  const Y = 618, size = 110;
  ctx.save(); ctx.font = `900 ${size}px ${KO}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const text = '돌탑 위키', chars = [...text], sp = -.02 * size, total = ctx.measureText(text).width + sp * (chars.length - 1), x0 = 960 - total / 2;
  ctx.shadowColor = 'rgba(2,6,12,0.5)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 9;
  let k2 = 0;
  chars.forEach((ch, k) => {
    if (ch === ' ') return; const t0 = OT.titleAt + (k2++) * OT.titleStep, p = seg(i, t0, t0 + 10); if (p <= 0) return;
    const pre = ctx.measureText(chars.slice(0, k).join('')).width + sp * k;
    const a = easeOutCubic(seg(i, t0, t0 + 5)) * (1 - easeInCubic(ex)), dy = 28 * (1 - easeOutBack(p, 2)) - 40 * easeInCubic(ex);
    const blur = (1 - seg(i, t0, t0 + 4)) * 8 + ex * 5;
    ctx.globalAlpha = a; ctx.filter = blur > .3 ? `blur(${blur.toFixed(2)}px)` : 'none'; ctx.fillStyle = C.text; ctx.fillText(ch, x0 + pre, Y + dy);
  });
  ctx.filter = 'none';
  const su = seg(i, OT.subAt, OT.subAt + 10);
  if (su > 0) { ctx.globalAlpha = easeOutCubic(su) * (1 - easeInCubic(ex)); ctx.letterSpacing = `${lerp(12, 2, easeOutExpo(su))}px`;
    txt('Doltap Wiki', 960, 676 + 8 * (1 - easeOutBack(su, 2)) - 30 * easeInCubic(ex), `700 36px ${KO}`, C.mono, 'center'); ctx.letterSpacing = '0px'; }
  ctx.restore();
}

/* =====================================================================
   frame renderer""")
rep("""/* boot */""", """/* v3: shift every story event by OPEN (= 3 beats) and add the opening's own events */
(() => {
  const E = window.EVENTS, sh = f => f + OPEN;
  E.frames = NF; E.land = E.land.map(e => ({ f: sh(e.f), heavy: e.heavy })); E.type = E.type.map(sh); E.glitch = E.glitch.map(sh);
  E.swell = E.swell.map(sh); E.chime = sh(E.chime); E.pop = E.pop.map(sh); E.hit = sh(E.hit); E.title = sh(E.title);
  E.land = [...OPEN_STONES.map(s => ({ f: s.land, heavy: .22 })), ...E.land];
  E.place = 15; E.whoosh = [OT.scatter + 2]; E.levels = { whoosh: -15 };
})();

/* boot */""")
# S1 machines enter a little later than v1m so they never sit under the exiting title
rep("keys: [K(-5, 400, 510, 1.0, 0), K(8, 400, 480, 1.18, 1, easeOutBack),", "keys: [K(-1, 400, 510, 1.0, 0), K(9, 400, 480, 1.18, 1, easeOutBack),")
rep("keys: [K(-3, 960, 510, 1.0, 0), K(10, 960, 480, 1.18, 1, easeOutBack),", "keys: [K(0, 960, 510, 1.0, 0), K(10, 960, 480, 1.18, 1, easeOutBack),")
rep("keys: [K(-1, 1520, 510, 1.0, 0), K(12, 1520, 480, 1.18, 1, easeOutBack),", "keys: [K(1, 1520, 510, 1.0, 0), K(11, 1520, 480, 1.18, 1, easeOutBack),")
open(D + 'showreel-v3.html', 'w').write(s); print('ok', len(s))
