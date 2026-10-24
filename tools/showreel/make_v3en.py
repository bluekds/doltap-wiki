import sys, re
import os
D = os.path.dirname(os.path.abspath(__file__)) + '/'
s = open(D + 'showreel-v3.html').read()
def rep(old, new, count=1):
    global s
    c = s.count(old)
    if c != count: sys.exit('count %d != %d for: %s' % (c, count, old[:100]))
    s = s.replace(old, new)
rep('<html lang="ko">', '<html lang="en">')
rep('<title>Doltap Wiki Showreel v3</title>', '<title>Doltap Wiki Showreel v3 (English)</title>')
rep("   v3 = v1m (beat-nudged v1) + a 45-frame opening title card: 495 frames = 16.5 s.",
    "   v3-en = v3 with English on-screen copy (same timeline, visuals, music/SFX events).\n"
    "   v3 = v1m (beat-nudged v1) + a 45-frame opening title card: 495 frames = 16.5 s.")
rep("""const KO = '"Apple SD Gothic Neo"';""", """const KO = '"Apple SD Gothic Neo"';
// English display face: SF Pro via system-ui. Chromium cannot see "SF Pro Display" by name on this Mac
// (it measures identical to the monospace fallback), but system-ui resolves to SF Pro (SFNS.ttf) with
// real 700/800/900 faces. Helvetica Neue is the declared fallback.
const EN = 'system-ui, "Helvetica Neue", sans-serif';""")
for ko, en in [('같은 문제, 매번 처음부터.', 'Same problem. From scratch, every time.'), ('해결한 것은 돌 하나가 됩니다.', 'Every fix becomes a stone.'),
               ('여러 머신, 여러 에이전트, 하나의 돌탑.', 'Many machines, many agents, one cairn.'), ('다음 에이전트는 바로 찾습니다.', 'The next agent finds it instantly.'),
               ('사람도 읽고 고칩니다.', 'Humans read and edit it too.')]:
    rep("text: '%s'" % ko, "text: '%s'" % en)
# headline: SF Pro Heavy, -2 % tracking, auto-fit to the safe area, per-word kinetic stagger
m = re.search(r"/\* ---------------- headline \(kinetic per syllable\) ---------------- \*/\nfunction headline\(text, at, end, i, size = 84, y = 214\) \{.*?\n\}\n", s, re.S)
assert m
s = s[:m.start()] + r"""/* ---------------- headline (English: kinetic per word, SF Pro Heavy) ---------------- */
function headline(text, at, end, i, size = 80, y = 214) {
  if (i < at || i >= end) return;
  ctx.save(); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const fit = sz => { ctx.font = `800 ${sz}px ${EN}`; ctx.letterSpacing = `${(-.02 * sz).toFixed(2)}px`; return ctx.measureText(text).width; };
  let total = fit(size); if (total > 1640) { size = Math.floor(size * 1640 / total); total = fit(size); }   // stay inside the 5 % safe area
  const x0 = W / 2 - total / 2, ex = seg(i, end - 5, end - 1);
  const words = []; let k = 0; for (const w of text.split(' ')) { words.push([w, k]); k += w.length + 1; }
  ctx.shadowColor = 'rgba(2,6,12,0.45)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
  words.forEach(([w, start], n) => {
    const t0 = at + n * 1.8, p = seg(i, t0, t0 + 11); if (p <= 0) return;
    const pre = ctx.measureText(text.slice(0, start)).width;
    const a = easeOutCubic(seg(i, t0, t0 + 5)) * (1 - easeInCubic(ex));
    const dy = 24 * (1 - easeOutBack(p, 2.2)) - 22 * easeInCubic(ex);
    const blur = (1 - seg(i, t0, t0 + 4)) * 7 + ex * 4;
    ctx.globalAlpha = a; ctx.filter = blur > .3 ? `blur(${blur.toFixed(2)}px)` : 'none';
    ctx.fillStyle = C.text; ctx.fillText(w, x0 + pre, y + dy);
  });
  ctx.filter = 'none'; ctx.letterSpacing = '0px'; ctx.restore();
}
""" + s[m.end():]
# ending title: big "Doltap Wiki" (per character, sheen), secondary line in Korean
rep("const TITLE_CV = document.createElement('canvas'); TITLE_CV.width = 900; TITLE_CV.height = 230;",
    "const TITLE_CV = document.createElement('canvas'); TITLE_CV.width = 1300; TITLE_CV.height = 230;")
rep("""  // 돌탑 위키 (per-character rise, sheen)
  tctx.clearRect(0, 0, 900, 230); tctx.font = `900 140px ${KO}`; tctx.textBaseline = 'alphabetic';
  const text = '돌탑 위키', chars = [...text], sp = -.02 * 140, total = tctx.measureText(text).width + sp * (chars.length - 1), x0 = 450 - total / 2;
  chars.forEach((ch, k) => { if (ch === ' ') return; const t0 = T.title + k * 2, p = seg(i, t0, t0 + 12); if (p <= 0) return;""",
    """  // Doltap Wiki (per-character rise, sheen)
  tctx.clearRect(0, 0, 1300, 230); tctx.font = `800 140px ${EN}`; tctx.textBaseline = 'alphabetic';
  const text = 'Doltap Wiki', chars = [...text], sp = -.02 * 140, total = tctx.measureText(text).width + sp * (chars.length - 1), x0 = 650 - total / 2;
  chars.forEach((ch, k) => { if (ch === ' ') return; const t0 = T.title + k * 1.3, p = seg(i, t0, t0 + 12); if (p <= 0) return;""")
rep("const bx = lerp(-200, 1100, easeInOutCubic(sh));", "const bx = lerp(-200, 1500, easeInOutCubic(sh));")
rep("tctx.fillStyle = g; tctx.fillRect(0, 0, 900, 230); tctx.restore(); }", "tctx.fillStyle = g; tctx.fillRect(0, 0, 1300, 230); tctx.restore(); }")
rep("ctx.drawImage(TITLE_CV, 960 - 450, 738 - 160);", "ctx.drawImage(TITLE_CV, 960 - 650, 738 - 160);")
rep("  // Doltap Wiki\n  const su = seg(i, T.sub, T.sub + 10);", "  // 돌탑 위키 · cairn wiki\n  const su = seg(i, T.sub, T.sub + 10);")
rep("txt('Doltap Wiki', 960, 808 + 10 * (1 - easeOutBack(su, 2)), `700 44px ${KO}`, C.mono, 'center');",
    "txt('돌탑 위키 · cairn wiki', 960, 808 + 10 * (1 - easeOutBack(su, 2)), `700 42px ${KO}`, C.mono, 'center');")
# opening title
rep("""  ctx.save(); ctx.font = `900 ${size}px ${KO}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const text = '돌탑 위키', chars = [...text], sp = -.02 * size, total = ctx.measureText(text).width + sp * (chars.length - 1), x0 = 960 - total / 2;""",
    """  ctx.save(); ctx.font = `800 ${size}px ${EN}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const text = 'Doltap Wiki', chars = [...text], sp = -.02 * size, total = ctx.measureText(text).width + sp * (chars.length - 1), x0 = 960 - total / 2;""")
rep("const OT = { titleAt: 1, titleStep: 1.0, subAt: 7, scatter: 36, titleOut: [41, 46] };",
    "const OT = { titleAt: 1, titleStep: .6, subAt: 7, scatter: 36, titleOut: [41, 46] };   // 10 Latin glyphs: faster step, readable 17..41")
rep("txt('Doltap Wiki', 960, 676 + 8 * (1 - easeOutBack(su, 2)) - 30 * easeInCubic(ex), `700 36px ${KO}`, C.mono, 'center');",
    "txt('돌탑 위키 · cairn wiki', 960, 676 + 8 * (1 - easeOutBack(su, 2)) - 30 * easeInCubic(ex), `700 36px ${KO}`, C.mono, 'center');")
rep("document.fonts.load(`400 28px Menlo`, 'wiki'),", "document.fonts.load(`400 28px Menlo`, 'wiki'), document.fonts.load(`800 80px ${EN}`, 'Doltap'), document.fonts.load(`700 40px ${KO}`, 'cairn'),")
open(D + 'showreel-v3-en.html', 'w').write(s); print('ok', len(s))
