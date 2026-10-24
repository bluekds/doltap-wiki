#!/usr/bin/env python3
"""Synthesize the sound bed for the showreel from out/events.json (exported by showreel.html).

Layers: detuned low pad (55 / 82.5 Hz, slow tremolo), stone-landing thuds (noise burst + 60 Hz
decaying sine), typing ticks (2 ms 2 kHz click), glitch buzz (60 ms square-ish 180 Hz), agent
pops, a rising swell (filtered noise + 200->800 Hz sweep) over frames 360-400 and an A-major
chime when the title lands. Output: out/sound.wav, 48 kHz stereo 16-bit, peak <= -1.5 dBFS.
"""
import json, os, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
ev = json.load(open(os.path.join(HERE, 'out', 'events.json')))
FPS, N = ev['fps'], ev['frames']
DUR = N / FPS
n = int(round(DUR * SR))
t = np.arange(n) / SR
L = np.zeros(n); R = np.zeros(n)
rng = np.random.default_rng(7)
f2s = lambda f: int(round(f / FPS * SR))


def add(sig, start, pan=0.0, gain=1.0):
    s = max(0, start); e = min(n, start + len(sig))
    if e <= s: return
    seg = sig[s - start:e - start] * gain
    L[s:e] += seg * np.sqrt(0.5 * (1 - pan)); R[s:e] += seg * np.sqrt(0.5 * (1 + pan))


def onepole_lp(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); acc = 0.0
    for k in range(len(x)): acc = (1 - a) * x[k] + a * acc; y[k] = acc
    return y


def env_ad(length, attack, decay_tau):
    tt = np.arange(length) / SR
    return np.minimum(1, tt / max(attack, 1e-4)) * np.exp(-tt / decay_tau)


# --- pad drone ---------------------------------------------------------------
trem = 0.75 + 0.25 * np.sin(2 * np.pi * 0.22 * t)
pad = (np.sin(2 * np.pi * 55 * t) + np.sin(2 * np.pi * 55.35 * t + 1.1)
       + 0.7 * np.sin(2 * np.pi * 82.5 * t + .4) + 0.7 * np.sin(2 * np.pi * 82.9 * t + 2.0)
       + 0.18 * np.sin(2 * np.pi * 165 * t + .7)) * trem
fade = np.minimum(1, t / 0.5) * np.minimum(1, (DUR - t) / 0.8)
pad *= fade * 0.05
# warmer after the cairn starts growing, brighter on the logo
pad *= 0.8 + 0.4 * np.clip((t - 4.3) / 6, 0, 1)
L += pad; R += pad * 0.97

# --- stone landings ------------------------------------------------------------
for k, e in enumerate(ev['land']):
    m = int(0.14 * SR); tt = np.arange(m) / SR
    noise = onepole_lp(rng.standard_normal(m), 900) * env_ad(m, 0.001, 0.03)
    body = np.sin(2 * np.pi * (60 + 25 * np.exp(-tt / 0.02)) * tt) * env_ad(m, 0.002, 0.05)
    sig = (1.6 * noise + 0.9 * body) * e['heavy']
    add(sig, f2s(e['f']), pan=float(np.clip((k % 3 - 1) * 0.15, -1, 1)), gain=0.55)

# --- typing ticks --------------------------------------------------------------
for k, f in enumerate(sorted(set(ev['type']))):
    m = int(0.002 * SR); tt = np.arange(m) / SR
    click = np.sin(2 * np.pi * 2000 * tt) * np.hanning(m)
    tail = onepole_lp(rng.standard_normal(int(0.01 * SR)), 4000) * env_ad(int(0.01 * SR), 0.0005, 0.002) * 0.4
    add(np.concatenate([click, tail]), f2s(f) + int(rng.integers(0, 200)), pan=rng.uniform(-.2, .2), gain=0.22)

# --- glitch buzz ---------------------------------------------------------------
for f in ev['glitch']:
    m = int(0.06 * SR); tt = np.arange(m) / SR
    sq = np.tanh(4 * np.sin(2 * np.pi * 180 * tt)) * (0.6 + 0.4 * (rng.random(m) > 0.3))
    sig = sq * np.hanning(m) * 0.9 + onepole_lp(rng.standard_normal(m), 3000) * np.hanning(m) * 0.25
    add(sig, f2s(f), pan=rng.uniform(-.5, .5), gain=0.11)

# --- agent pops ----------------------------------------------------------------
for f in ev['pop']:
    m = int(0.09 * SR); tt = np.arange(m) / SR
    sig = np.sin(2 * np.pi * (520 + 700 * tt / 0.09) * tt) * env_ad(m, 0.003, 0.025)
    add(sig, f2s(f), gain=0.08)

# --- swell 360 -> 400 ------------------------------------------------------------
s0, s1 = ev['swell']; m = f2s(s1) - f2s(s0); tt = np.arange(m) / SR; u = tt / tt[-1]
freq = 200 * (800 / 200) ** u
sweep = np.sin(2 * np.pi * np.cumsum(freq) / SR)
noise = rng.standard_normal(m); hp = noise - onepole_lp(noise, 400); air = onepole_lp(hp, 2500 + 4000 * u.mean())
sw = (0.5 * sweep + 0.9 * air) * (u ** 2.2) * np.minimum(1, (1 - u) / 0.04 + 0.0)
add(sw, f2s(s0), gain=0.12)

# --- chime (A major: A4 C#5 E5 + a soft A5) ----------------------------------------
m = int(2.2 * SR); tt = np.arange(m) / SR; ch = np.zeros(m)
for fr, a in [(440, 1), (554.37, .8), (659.25, .7), (880, .35)]:
    ch += a * (np.sin(2 * np.pi * fr * tt) + 0.12 * np.sin(2 * np.pi * fr * 2.76 * tt) * np.exp(-tt / 0.15)) * np.exp(-tt / 0.55)
ch *= np.minimum(1, tt / 0.004)
add(ch, f2s(ev['chime']), pan=-0.1, gain=0.07); add(ch, f2s(ev['chime']) + int(0.011 * SR), pan=0.25, gain=0.045)

# --- master ------------------------------------------------------------------------
st = np.stack([L, R], 1)
st *= np.minimum(1, (DUR - t) / 0.8)[:, None]
peak = np.abs(st).max(); target = 10 ** (-1.5 / 20)
st *= target / peak
out = os.path.join(HERE, 'out', 'sound.wav')
with wave.open(out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((st * 32767).astype('<i2').tobytes())
rms = np.sqrt((st ** 2).mean())
print('%s  %.3fs  peak %.2f dBFS  rms %.1f dBFS' % (out, n / SR, 20 * np.log10(np.abs(st).max()), 20 * np.log10(rms)))
