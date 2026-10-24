#!/usr/bin/env python3
"""Contact sheet: 15 key frames (one per second, frame 30k+OFF; OFF=15 default, v2 uses 20 so samples fall
between beats rather than on flash frames) tiled 5x3 with timestamps. usage: contact.py SRC DST [TITLE] [OFF]"""
import os, sys
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'out', 'frames')
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'out', 'contact-sheet.png')
import math
total = len([f for f in os.listdir(src) if f.endswith('.png')])
nkey = math.ceil(total / 30)                       # one per second: 15 for 15 s, 17 for 16.5 s
cols = 5 if nkey <= 15 else 6; rows = math.ceil(nkey / cols)
cw, ch, pad, top = 480, 270, 12, 64
font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 20)
big = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 26)
sheet = Image.new('RGB', (cols * cw + (cols + 1) * pad, top + rows * ch + (rows + 1) * pad), (8, 14, 22))
d = ImageDraw.Draw(sheet)
d.text((pad, 18), (sys.argv[3] if len(sys.argv) > 3 else 'Doltap Wiki showreel') + ' - contact sheet (frame 30k+%s, 1 per second)' % (sys.argv[4] if len(sys.argv) > 4 else '15'), fill=(242, 242, 240), font=big)
for k in range(nkey):
    f = min(total - 1, 30 * k + (int(sys.argv[4]) if len(sys.argv) > 4 else 15))
    im = Image.open(os.path.join(src, '%04d.png' % f)).convert('RGB').resize((cw, ch), Image.LANCZOS)
    x, y = pad + (k % cols) * (cw + pad), top + pad + (k // cols) * (ch + pad)
    sheet.paste(im, (x, y))
    lab = '%05.2fs  f%03d' % (f / 30, f)
    d.rectangle([x, y, x + 182, y + 28], fill=(0, 0, 0))
    d.text((x + 8, y + 3), lab, fill=(255, 214, 10), font=font)
sheet.save(dst); print(dst, sheet.size)
