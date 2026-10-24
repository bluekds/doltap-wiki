#!/usr/bin/env python3
"""Log-frequency spectrogram of a WAV with section markers (review aid). usage: spectro.py in.wav out.png"""
import sys, wave
import numpy as np
from PIL import Image, ImageDraw, ImageFont
w = wave.open(sys.argv[1]); sr = w.getframerate()
x = np.frombuffer(w.readframes(w.getnframes()), '<i2').reshape(-1, 2).mean(1) / 32768
hop, nfft = 240, 4096; win = np.hanning(nfft)
frames = [x[i:i + nfft] * win for i in range(0, len(x) - nfft, hop)]
S = 20 * np.log10(np.abs(np.fft.rfft(np.array(frames), axis=1)) + 1e-7)
f = np.fft.rfftfreq(nfft, 1 / sr); H = 360
logf = np.geomspace(30, 16000, H); idx = np.searchsorted(f, logf)
img = S[:, idx].T[::-1]; img = np.clip((img + 30) / 60, 0, 1)
W = img.shape[1]
rgb = np.stack([img ** 0.7 * 255, img ** 1.4 * 220, (1 - img) * 60 + img * 90], -1).astype(np.uint8)
im = Image.fromarray(rgb).resize((1500, H)); d = ImageDraw.Draw(im)
font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 13)
for s in [1.75, 2, 7.5, 10, 12, 13, 15]:
    X = int(s / 15 * 1500); d.line([X, 0, X, H], fill=(255, 255, 255), width=1); d.text((X + 3, 3), '%gs' % s, fill=(255, 255, 0), font=font)
for hz in [50, 100, 200, 500, 1000, 2000, 5000, 10000]:
    Y = H - 1 - int(np.searchsorted(logf, hz)); d.text((3, Y - 7), str(hz), fill=(200, 200, 200), font=font)
# rms strip
rms = [np.sqrt((x[i:i + sr // 20] ** 2).mean()) for i in range(0, len(x), sr // 20)]
strip = Image.new('RGB', (1500, 80), (10, 10, 10)); d2 = ImageDraw.Draw(strip)
for k, r in enumerate(rms):
    X = int(k / len(rms) * 1500); h = int(np.clip((20 * np.log10(r + 1e-9) + 40) / 40, 0, 1) * 78); d2.rectangle([X, 79 - h, X + 4, 79], fill=(120, 200, 90))
out = Image.new('RGB', (1500, H + 80)); out.paste(im, (0, 0)); out.paste(strip, (0, H)); out.save(sys.argv[2]); print(sys.argv[2])
