#!/usr/bin/env python3
"""Procedural music bed for the Doltap Wiki showreel (numpy only, no samples, no network).

120 BPM (1 beat = 0.5 s = 15 video frames), A major. Bars of 2 s start at t = 1.0 s so that the
title impact at 13.0 s (frame 390) is a downbeat; 0-1 s is a pickup.

  0.00-1.75  intro: low A drone, dark filtered pad, sparse ticking hats, reverse swell
  1.75       HIT (agent pop at the end of S1): kick + crash + chord stab
  2.00-7.50  groove builds: 4-on-floor kick with sidechain pumping, 8th plucked bass;
             +16th arp from 3.0, +clap on 2/4 and open hats from 5.0
  7.50-10.0  "found it": brighter lead melody with ping-pong delay, pad opens
 10.00-12.0  pull-back: kick out, arp + pad stay, tom fill 10.5-11.5
 12.00-13.0  rise: noise riser + sweep, kicks, snare roll 8ths -> 16ths -> 32nds
 13.00       IMPACT (title lands): big kick, crash, sub drop, A-major stab
 13.00-15.0  tail: A-major chord in reverb, arp fading, smooth fade to silence at 15.000 s

Chords (bar = 2 s): A | F#m | D | E | A | F#m (11-12) E (12-13) | A
Writes out/music.wav (48 kHz stereo 16-bit) and prints per-section RMS.

MUSIC_OFFSET=1.5 MUSIC_OUT=music-v3.wav (v3): the whole arrangement above starts 1.5 s (3 beats) later
and is preceded by a pre-intro for the opening title card: A-major pad swelling from silence, a gentle
reverse cymbal into 1.5 s and a soft placement thud + tick when the title lands (frame 15). 16.5 s total.
"""
import os, wave
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 48000
OFF = float(os.environ.get('MUSIC_OFFSET', '0'))   # seconds of pre-intro before the arrangement
DUR = 15.0 + OFF
N = int(DUR * SR)
BEAT = 0.5
rng = np.random.default_rng(1203)
t_all = np.arange(N) / SR


def midi(m): return 440.0 * 2 ** ((m - 69) / 12)


# ---------------------------------------------------------------- harmony
CHORDS = [(0.0, 'A'), (3.0, 'F#m'), (5.0, 'D'), (7.0, 'E'), (9.0, 'A'), (11.0, 'F#m'), (12.0, 'E'), (13.0, 'A')]
PAD_V = {'A': [57, 61, 64, 69], 'F#m': [54, 57, 61, 66], 'D': [54, 57, 62, 66], 'E': [52, 56, 59, 64]}
BASS = {'A': 33, 'F#m': 30, 'D': 38, 'E': 40}
ARP = {'A': [69, 73, 76, 81], 'F#m': [66, 69, 73, 78], 'D': [66, 69, 74, 78], 'E': [64, 68, 71, 76]}


def chord_at(t):
    c = CHORDS[0][1]
    for s, n in CHORDS:
        if t >= s - 1e-9: c = n
    return c


def chord_spans():
    out = []
    for k, (s, n) in enumerate(CHORDS):
        e = CHORDS[k + 1][0] if k + 1 < len(CHORDS) else DUR
        out.append((s, e, n))
    return out


# ---------------------------------------------------------------- buses
class Bus:
    def __init__(self): self.L = np.zeros(N); self.R = np.zeros(N)

    def add(self, sig, t0, gain=1.0, pan=0.0, sigR=None, absolute=False):
        i0 = int(round((t0 + (0 if absolute else OFF)) * SR)); sR = sig if sigR is None else sigR
        if i0 >= N: return
        a, b = max(0, i0), min(N, i0 + len(sig))
        if b <= a: return
        gl, gr = gain * np.sqrt(.5 * (1 - pan)), gain * np.sqrt(.5 * (1 + pan))
        self.L[a:b] += sig[a - i0:b - i0] * gl; self.R[a:b] += sR[a - i0:b - i0] * gr

    def st(self): return np.stack([self.L, self.R], 1)


drums, bass, pad, arp, lead, fx = Bus(), Bus(), Bus(), Bus(), Bus(), Bus()


# ---------------------------------------------------------------- oscillators
def saw_additive(f0, n, cutoff, detune_phase=0.0, odd_only=False, max_h=60):
    """band-limited saw/square via additive partials; cutoff (Hz, scalar or array) = 1-pole-like rolloff"""
    tt = np.arange(n) / SR; out = np.zeros(n)
    kmax = int(min(max_h, (SR / 2 - 200) / f0))
    for k in range(1, kmax + 1):
        if odd_only and k % 2 == 0: continue
        fk = f0 * k
        w = 1.0 / np.sqrt(1.0 + (fk / cutoff) ** 4)
        if np.isscalar(w) and w < 2e-3: break
        out += (w / k) * np.sin(2 * np.pi * fk * tt + detune_phase * k)
    return out


def pluck(f0, dur, bright=3000, decay=0.18, odd=False):
    n = int(dur * SR); tt = np.arange(n) / SR; out = np.zeros(n)
    kmax = int(min(40, (SR / 2 - 200) / f0))
    for k in range(1, kmax + 1):
        if odd and k % 2 == 0: continue
        fk = f0 * k
        if fk > bright * 3: break
        a = (1.0 / k) / np.sqrt(1 + (fk / bright) ** 2)
        out += a * np.sin(2 * np.pi * fk * tt) * np.exp(-tt * (1 / decay) * (1 + 0.25 * k))
    att = np.minimum(1, tt / 0.002)
    return out * att


def env_exp(n, tau, attack=0.002):
    tt = np.arange(n) / SR
    return np.minimum(1, tt / attack) * np.exp(-tt / tau)


def lowpass_fft(x, fc, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / (1 + (f / fc) ** (2 * order)), len(x))


def highpass_fft(x, fc, order=2):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    h = (f / fc) ** (2 * order); return np.fft.irfft(X * h / (1 + h), len(x))


def noise(n): return rng.standard_normal(n)


# ---------------------------------------------------------------- drums
def kick(big=1.0):
    n = int(0.45 * SR); tt = np.arange(n) / SR
    f = 48 + 110 * np.exp(-tt / 0.035) * big
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-tt / (0.22 if big > 1 else 0.16))
    click = highpass_fft(noise(n), 2000) * np.exp(-tt / 0.004) * 0.25
    return np.tanh(1.6 * (body + click)) * 0.9


def clap():
    n = int(0.3 * SR); tt = np.arange(n) / SR; nz = highpass_fft(lowpass_fft(noise(n), 6000), 900)
    e = np.zeros(n)
    for d in (0.0, 0.011, 0.022): e += (tt >= d) * np.exp(-(tt - d).clip(0) / 0.012) * 0.6
    e += np.exp(-tt / 0.09) * 0.55
    return nz * e


def hat(open_=False):
    n = int((0.35 if open_ else 0.06) * SR); tt = np.arange(n) / SR
    nz = highpass_fft(noise(n), 7000)
    return nz * np.exp(-tt / (0.12 if open_ else 0.014)) * (1.2 if open_ else 1.4)


def tom(f0):
    n = int(0.35 * SR); tt = np.arange(n) / SR
    f = f0 * (1 + 0.6 * np.exp(-tt / 0.03)); ph = 2 * np.pi * np.cumsum(f) / SR
    return (np.sin(ph) * np.exp(-tt / 0.14) + 0.15 * lowpass_fft(noise(n), 3000) * np.exp(-tt / 0.02)) * 0.8


def crash(dur=2.0):
    n = int(dur * SR); tt = np.arange(n) / SR
    nz = highpass_fft(noise(n), 3500) * 0.6 + highpass_fft(noise(n), 6000) * 0.4
    return nz * np.exp(-tt / (dur * 0.33)) * np.minimum(1, tt / 0.001)


def snare():
    n = int(0.22 * SR); tt = np.arange(n) / SR
    body = np.sin(2 * np.pi * 190 * tt) * np.exp(-tt / 0.05) * 0.5
    nz = highpass_fft(lowpass_fft(noise(n), 8000), 1200) * np.exp(-tt / 0.07)
    return body + nz * 0.8


KICKS = [k * BEAT for k in range(4, 20)]                      # 2.0 .. 9.5
KICKS += [12.0, 12.5]
HIT, IMPACT = 1.75, 13.0
K = kick(); KB = kick(1.4)
for tk in KICKS: drums.add(K, tk, 0.8)
for tk in (HIT, IMPACT): drums.add(KB, tk, 1.15)
drums.add(crash(1.6), HIT, 0.30, -0.2, crash(1.6)); drums.add(crash(2.0), IMPACT, 0.38, 0.2, crash(2.0))
# clap on 2 & 4 (bars start at odd seconds -> beats 2/4 at x.5 of odd + 1.0)
for b in np.arange(3.5, 10.0, 1.0): drums.add(clap(), b, 0.6, 0.05)
# hats
for k in range(0, 14):                                         # intro ticks, 8ths, humanised
    tk = k * 0.125 * 1.0
    if tk >= HIT: break
    if k % 2 == 0 or rng.random() < 0.4: drums.add(hat(), tk * 1.0, 0.18 + 0.08 * (k % 4 == 0), rng.uniform(-.4, .4))
for k in range(int(2.0 / .125), int(10.0 / .125)):            # 16ths in groove
    tk = k * 0.125; acc = 1.0 if k % 4 == 2 else (0.6 if k % 2 == 0 else 0.4)
    if tk < 3.0 and k % 2: continue
    drums.add(hat(), tk, 0.28 * acc, 0.3 if k % 2 else -0.15)
for b in np.arange(5.25, 10.0, 0.5): drums.add(hat(True), b, 0.28, 0.25)       # open hats on off-beats
for k in range(int(10.0 / .25), int(12.0 / .25)): drums.add(hat(), k * 0.25, 0.22, 0.2 * (-1) ** k)
for k in range(int(12.0 / .125), int(13.0 / .125)): drums.add(hat(), k * 0.125, 0.25, 0.2 * (-1) ** k)
# tom fill 10.5 -> 11.5 (16ths, descending) -- the v2 graph links burst on these
fill = [(10.5 + j * .125, f) for j, f in enumerate([220, 196, 175, 165, 147, 131, 117, 110])]
for tk, f in fill: drums.add(tom(f), tk, 0.5, 0.5 - (tk - 10.5))
# snare roll in the rise
roll = [12.0 + j * .25 for j in range(2)] + [12.5 + j * .125 for j in range(3)] + [12.875 + j * .0625 for j in range(2)]
for j, tk in enumerate(roll): drums.add(snare(), tk, 0.18 + 0.06 * j, 0.1)
# reverse swell into the HIT
n = int(1.0 * SR); tt = np.arange(n) / SR
rs = highpass_fft(noise(n), 1500) * (tt / tt[-1]) ** 3 * 0.25
fx.add(rs, HIT - 1.0, 1.0, -0.3, highpass_fft(noise(n), 1500) * (tt / tt[-1]) ** 3 * 0.25)

# ---------------------------------------------------------------- sidechain pump (only where kicks play)
pump = np.ones(N)
for tk in KICKS + [HIT, IMPACT]:
    i0 = int((tk + OFF) * SR); m = min(N - i0, int(0.45 * SR)); tt = np.arange(m) / SR
    pump[i0:i0 + m] = np.minimum(pump[i0:i0 + m], 1 - 0.62 * np.exp(-tt / 0.11) * np.minimum(1, tt / 0.004 + 0.6))

# ---------------------------------------------------------------- bass: 8th plucks with octave bounce
for k in range(int(2.0 / .25), int(13.0 / .25)):
    tk = k * 0.25
    if 10.0 <= tk < 12.0 and k % 2: continue                  # pull-back: quarter notes only
    c = chord_at(tk + 1e-6); m = BASS[c] + (12 if k % 2 else 0)
    p = pluck(midi(m), 0.32, bright=700 + 500 * (7.5 <= tk < 10), decay=0.12)
    p2 = np.sin(2 * np.pi * midi(BASS[c]) * np.arange(len(p)) / SR) * np.exp(-np.arange(len(p)) / SR / 0.14)
    bass.add(np.tanh(2.2 * (p + 0.45 * p2)) * 0.55, tk, 0.68)
# sub hit at impact
n = int(1.6 * SR); tt = np.arange(n) / SR
bass.add(np.sin(2 * np.pi * np.cumsum(55 * (1 + .8 * np.exp(-tt / .08))) / SR) * np.exp(-tt / 0.5), IMPACT, 0.8)

# ---------------------------------------------------------------- pad (detuned additive saws, moving filter)
def cutoff_curve(t):
    pts = [(0, 400), (1.75, 800), (2.0, 1400), (7.0, 2200), (7.5, 3400), (10.0, 3400), (10.01, 1500),
           (12.0, 1500), (13.0, 5000), (15.0, 1800)]
    xs, ys = zip(*pts); return np.interp(t, xs, ys)


for s, e, c in chord_spans():
    n = int((e - s + 0.6) * SR); tt = np.arange(n) / SR + s
    fc = cutoff_curve(tt)
    env = np.minimum(1, (tt - s) / 0.08) * np.clip((e + 0.6 - tt) / 0.6, 0, 1)
    if c == 'A' and s == 13.0: env = np.minimum(1, (tt - s) / 0.01) * np.exp(-(tt - s) / 1.6)
    L = np.zeros(n); R = np.zeros(n)
    for m in PAD_V[c]:
        f = midi(m)
        L += saw_additive(f * 2 ** (-6 / 1200), n, fc, 0.3, max_h=30)
        R += saw_additive(f * 2 ** (+6 / 1200), n, fc, 1.7, max_h=30)
    pad.add(L * env, s, 0.065, -0.6, R * env)
# low A drone for the intro
n = int(2.3 * SR); tt = np.arange(n) / SR
dr = (np.sin(2 * np.pi * 55 * tt) + 0.5 * np.sin(2 * np.pi * 82.5 * tt + 1)) * np.minimum(1, tt / 0.4) * np.clip((2.3 - tt) / 0.5, 0, 1)
pad.add(dr, 0.0, 0.10)


# ---------------------------------------------------------------- arp 16ths
for k in range(int(3.0 / .125), int(14.5 / .125)):
    tk = k * 0.125
    if 12.0 <= tk < 13.0: continue                             # rise: arp drops out (riser takes over)
    c = chord_at(tk + 1e-6); notes = ARP[c]
    seq = [0, 1, 2, 3, 2, 1, 2, 3]; m = notes[seq[k % 8]] + (12 if (7.5 <= tk < 10 and k % 4 == 3) else 0)
    br = 3000 + 2500 * (7.5 <= tk < 10) + (900 if tk >= 13 else 0)
    p = pluck(midi(m), 0.25, bright=br, decay=0.07, odd=True)
    g = 0.42 * (1.0 if tk < 13 else max(0, 1 - (tk - 13) / 1.5)) * (1.1 if k % 4 == 0 else 0.85)
    arp.add(p, tk, g, 0.35 * np.sin(k * 0.7))

# ---------------------------------------------------------------- lead (found it)
MEL = [(7.5, .25, 71), (7.75, .25, 73), (8.0, .5, 76), (8.5, .25, 80), (8.75, .25, 78), (9.0, .5, 76),
       (9.5, .25, 73), (9.75, .25, 76)]
for s, d, m in MEL:
    n = int((d + 0.25) * SR); tt = np.arange(n) / SR; f = midi(m)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * tt) * np.minimum(1, tt / 0.15)
    ph = 2 * np.pi * np.cumsum(f * vib) / SR
    sig = sum((1 / k) * np.sin(k * ph) / np.sqrt(1 + (k * f / 3500) ** 2) for k in range(1, 16, 2))
    env = np.minimum(1, tt / 0.006) * np.where(tt < d, 1.0, np.exp(-(tt - d) / 0.05)) * (0.85 + 0.15 * np.exp(-tt / 0.1))
    lead.add(sig * env, s, 0.30, 0.1)

# ---------------------------------------------------------------- riser 12 -> 13 and impact stab
n = int(1.0 * SR); tt = np.arange(n) / SR; u = tt / tt[-1]
sweep = np.sin(2 * np.pi * np.cumsum(200 * 4 ** u) / SR) * 0.35
nz = highpass_fft(noise(n), 800); nz = nz * (0.3 + u)
fx.add((sweep + 0.5 * nz) * u ** 2, 12.0, 0.32, -0.2, (sweep + 0.5 * highpass_fft(noise(n), 800) * (0.3 + u)) * u ** 2)
n = int(2.0 * SR); tt = np.arange(n) / SR; st = np.zeros(n)
for m in [45, 57, 61, 64, 69, 73]: st += saw_additive(midi(m), n, 3000 * np.exp(-tt / 0.5) + 300, 0.0, max_h=40)
fx.add(st * np.exp(-tt / 0.7) * np.minimum(1, tt / 0.003), IMPACT, 0.12, 0.0)
n = int(1.2 * SR); tt = np.arange(n) / SR; st = np.zeros(n)
for m in [57, 61, 64, 69]: st += saw_additive(midi(m), n, 2000 * np.exp(-tt / 0.3) + 300, 0.0, max_h=30)
fx.add(st * np.exp(-tt / 0.35) * np.minimum(1, tt / 0.003), HIT, 0.09, 0.0)


# ---------------------------------------------------------------- v3 pre-intro (absolute times, before OFF)
if OFF > 0:
    n = int((OFF + 0.8) * SR); tt = np.arange(n) / SR; ramp = np.clip(tt / OFF, 0, 1)
    env = ramp ** 2 * np.clip((OFF + 0.8 - tt) / 0.8, 0, 1)          # swell from silence, hand over to the old intro
    fc = 500 + 1000 * ramp
    Lp = sum(saw_additive(midi(m) * 2 ** (-5 / 1200), n, fc, .3, max_h=24) for m in PAD_V['A'])
    Rp = sum(saw_additive(midi(m) * 2 ** (5 / 1200), n, fc, 1.7, max_h=24) for m in PAD_V['A'])
    pad.add(Lp * env, 0.0, 0.085, -0.6, Rp * env, absolute=True)
    m = int(1.1 * SR); t2 = np.arange(m) / SR; sh = (t2 / t2[-1]) ** 3                # gentle reverse cymbal
    fx.add(highpass_fft(noise(m), 5000) * sh, OFF - 1.1, 0.11, -0.3, highpass_fft(noise(m), 5000) * sh, absolute=True)
    tp = 15 / 30; m = int(.3 * SR); t3 = np.arange(m) / SR                              # placement: soft thud + tick
    th = np.sin(2 * np.pi * (70 + 45 * np.exp(-t3 / .02)) * t3) * np.exp(-t3 / .08) + .3 * np.sin(2 * np.pi * 1760 * t3) * np.exp(-t3 / .012)
    drums.add(th * np.minimum(1, t3 / .002), tp, 0.42, 0.0, absolute=True)


# ---------------------------------------------------------------- effects
def pingpong(x, delay=0.375, fb=0.38, taps=4, damp=3500):
    L = np.zeros(N); R = np.zeros(N); d = int(delay * SR); y = lowpass_fft(x, damp)
    for k in range(1, taps + 1):
        sh = d * k
        if sh >= N: break
        (L if k % 2 else R)[sh:] += y[:N - sh] * fb ** k
    return L, R


def reverb(st_in, decay=1.6, pre=0.018, wet=0.25):
    n = int(decay * 2.2 * SR); tt = np.arange(n) / SR
    out = np.zeros_like(st_in)
    for ch in range(2):
        ir = noise(n) * np.exp(-tt / (decay / 6.9)); ir = lowpass_fft(ir, 5000) * (tt > pre)
        ir /= np.sqrt((ir ** 2).sum())
        L = len(st_in) + n; F = 1 << (L - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(st_in[:, ch], F) * np.fft.rfft(ir, F), F)[:len(st_in)]
        out[:, ch] = y
    return out * wet


arp_st = arp.st(); aL, aR = pingpong(arp.L * 0.5 + arp.R * 0.5)
arp_st[:, 0] += aL * 0.6; arp_st[:, 1] += aR * 0.6
lead_st = lead.st(); lL, lR = pingpong(lead.L + lead.R, fb=0.42)
lead_st[:, 0] += lL * 0.7; lead_st[:, 1] += lR * 0.7

pump2 = pump[:, None]
mix = drums.st() * 1.0 + bass.st() * pump2 + pad.st() * pump2 + arp_st * (0.55 + 0.45 * pump2) + lead_st + fx.st()
send = pad.st() * pump2 * 0.8 + arp_st * 0.5 + lead_st * 0.8 + fx.st() * 0.6 + drums.st() * 0.12
mix = mix + reverb(send, decay=1.8, wet=0.55)


# ---------------------------------------------------------------- master: compressor -> limiter -> fade
def compress(x, thr_db=-20, ratio=2.5, block=0.01, att=0.005, rel=0.12):
    b = int(block * SR); nb = len(x) // b + 1
    pad_ = np.zeros((nb * b, 2)); pad_[:len(x)] = x
    rms = np.sqrt((pad_.reshape(nb, b, 2) ** 2).mean(axis=(1, 2)) + 1e-12)
    lvl = 20 * np.log10(rms); over = np.maximum(0, lvl - thr_db); gdb = -over * (1 - 1 / ratio)
    sm = np.zeros(nb); g = 0.0
    for k in range(nb):
        a = np.exp(-block / (att if gdb[k] < g else rel)); g = a * g + (1 - a) * gdb[k]; sm[k] = g
    gs = np.interp(np.arange(len(x)), np.arange(nb) * b + b / 2, sm)
    return x * (10 ** (gs / 20))[:, None]


def limit(x, ceil_db=-1.2):
    c = 10 ** (ceil_db / 20)
    b = 96; nb = len(x) // b + 1; pad_ = np.zeros((nb * b, 2)); pad_[:len(x)] = x
    pk = np.abs(pad_.reshape(nb, b, 2)).max(axis=(1, 2))
    need = np.minimum(1, c * 0.92 / np.maximum(pk, 1e-9))
    need = np.minimum(need, np.r_[need[1:], 1])                # 2 ms look-ahead
    sm = np.zeros(nb); g = 1.0
    for k in range(nb):
        g = need[k] if need[k] < g else g + (1 - g) * (1 - np.exp(-b / SR / 0.08)); g = min(g, 1); sm[k] = g
    y = x * np.interp(np.arange(len(x)), np.arange(nb) * b, sm)[:, None]
    k = .8 * c; a = np.abs(y)                                   # soft-knee clip only above 80 % of the ceiling
    y = np.where(a <= k, y, np.sign(y) * (k + (c - k) * np.tanh((a - k) / (c - k))))
    return y



def master(x, target_rms_db=-16.0):
    # normalise first so the compressor threshold means the same thing every run, then a gentle
    # 2:1 above the groove level (keeps the arrangement's dynamics), make-up, look-ahead limiter
    rms = lambda v: np.sqrt((v ** 2).mean())
    x = x * 10 ** (target_rms_db / 20) / rms(x)
    x = compress(x, thr_db=-15, ratio=2.0)
    x = x * 10 ** (target_rms_db / 20) / rms(x)
    x = limit(x)

    fade = np.ones(len(x)); m = int(0.6 * SR); fade[-m:] = 0.5 * (1 + np.cos(np.linspace(0, np.pi, m)))
    fade[:int(0.01 * SR)] = np.linspace(0, 1, int(0.01 * SR))
    return x * fade[:, None]


def write_wav(path, x):
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


def sections(off=OFF):
    base = [('intro', 0, 1.75), ('groove', 2.0, 7.5), ('found', 7.5, 10), ('pull-back', 10, 12), ('rise', 12, 13), ('impact+tail', 13, 15)]
    out = [('pre-intro', 0, off)] if off > 0 else []
    return out + [('%s %g-%g' % (n, a + off, b + off), a + off, b + off) for n, a, b in base]


SECTIONS = sections()


def report(x, name, off=None):
    db = lambda v: 20 * np.log10(max(v, 1e-9))
    print('%s: peak %.2f dBFS, rms %.1f dBFS' % (name, db(np.abs(x).max()), db(np.sqrt((x ** 2).mean()))))
    for lab, a, b in (SECTIONS if off is None else sections(off)):
        s = x[int(a * SR):int(b * SR)]; print('   %-18s rms %6.1f dBFS  peak %6.1f' % (lab, db(np.sqrt((s ** 2).mean())), db(np.abs(s).max())))


MUSIC = master(mix)
if __name__ == '__main__':
    os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
    p = os.path.join(HERE, 'out', os.environ.get('MUSIC_OUT', 'music.wav')); write_wav(p, MUSIC); report(MUSIC, p)
