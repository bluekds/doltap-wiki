#!/usr/bin/env python3
"""Mix out/music.wav (from music.py) with the SFX layer for one cut.
usage: mix.py EVENTS.json OUT.wav [MUSIC.wav]   (duration and section offsets follow the events)"""
import sys, wave
import numpy as np
import sfx
from music import limit, write_wav, report, SR

ev_path, out = sys.argv[1], sys.argv[2]
import json
ev = json.load(open(ev_path))
w = wave.open(sys.argv[3] if len(sys.argv) > 3 else 'out/music.wav'); mus = np.frombuffer(w.readframes(w.getnframes()), '<i2').reshape(-1, 2) / 32767.
# per-layer peak targets (dBFS) so every effect sits on top of the -16 dBFS music bed
TARGET = {'thud': -1, 'tick': -8, 'glitch': -9, 'pop': -12, 'whoosh': -3, 'ping': -8, 'chime': -10}
TARGET.update(ev.get('levels', {}))
DUR = ev['frames'] / ev['fps']
fx = np.zeros_like(mus)
for name, layer in sfx.build(ev, dur=DUR).items():
    fx += layer * 10 ** (TARGET[name] / 20) / max(np.abs(layer).max(), 1e-9)
mixd = mus * sfx.duck_env(ev, dur=DUR)[:, None] + fx
mixd = limit(mixd, ceil_db=-1.2)
fade = np.ones(len(mixd)); m = int(.05 * SR); fade[-m:] = np.linspace(1, 0, m) ** 2   # music already fades; guard the last 50 ms
mixd *= fade[:, None]
write_wav(out, mixd); report(mixd, out, off=DUR - 15.0)
