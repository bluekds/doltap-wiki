#!/usr/bin/env python3
"""Tile frames into review sheets. usage: tile.py SRC_DIR OUT_PREFIX frame,frame,... [cols] [cellw]"""
import sys, os
from PIL import Image, ImageDraw, ImageFont
src, outp, frames = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split(',') if x]
cols = int(sys.argv[4]) if len(sys.argv) > 4 else 3
cw = int(sys.argv[5]) if len(sys.argv) > 5 else 640
ch = cw * 9 // 16
try: font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', max(14, cw // 28))
except Exception: font = ImageFont.load_default()
per = cols * 3
for s in range(0, len(frames), per):
    grp = frames[s:s + per]; rows = (len(grp) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cw, rows * ch), (0, 0, 0))
    for k, f in enumerate(grp):
        im = Image.open(os.path.join(src, '%04d.png' % f)).convert('RGB').resize((cw, ch), Image.LANCZOS)
        d = ImageDraw.Draw(im); d.rectangle([0, 0, cw // 4.2, cw // 22], fill=(0, 0, 0)); d.text((6, 2), 'f%03d %.2fs' % (f, f / 30), fill=(255, 220, 0), font=font)
        sheet.paste(im, ((k % cols) * cw, (k // cols) * ch))
    p = '%s_%02d.png' % (outp, s // per); sheet.save(p); print(p)
