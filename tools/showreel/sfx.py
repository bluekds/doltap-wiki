#!/usr/bin/env python3
"""Sound-effects layer (numpy) shared by the music mixes. Same design as audio.py (v1 SFX-only bed)
minus the drone and swell, which the music now provides; plus whooshes for v2 whip-pans and a
'found' ping on the S4 hit. Returns {layer: float stereo at 48 kHz}; the mixer sets each layer's level."""
import numpy as np

SR = 48000


def onepole_lp(x, fc):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X / np.sqrt(1 + (f / fc) ** 2), len(x))


def env_ad(n, attack, tau):
    tt = np.arange(n) / SR
    return np.minimum(1, tt / max(attack, 1e-4)) * np.exp(-tt / tau)


def build(ev, dur=15.0, seed=7):
    fps = ev['fps']; n = int(round(dur * SR)); layers = {}; cur = ['thud']
    rng = np.random.default_rng(seed); f2s = lambda f: int(round(f / fps * SR))

    def add(sig, start, pan=0.0, gain=1.0):
        st = layers.setdefault(cur[0], np.zeros((n, 2)))
        a, b = max(0, start), min(n, start + len(sig))
        if b <= a: return
        seg = sig[a - start:b - start] * gain
        st[a:b, 0] += seg * np.sqrt(.5 * (1 - pan)); st[a:b, 1] += seg * np.sqrt(.5 * (1 + pan))

    for k, e in enumerate(ev['land']):                       # stone thuds: noise burst + 60 Hz body
        m = int(0.16 * SR); tt = np.arange(m) / SR
        nz = onepole_lp(rng.standard_normal(m), 900) * env_ad(m, .001, .03)
        body = np.sin(2 * np.pi * (60 + 30 * np.exp(-tt / .02)) * tt) * env_ad(m, .002, .055)
        # stone-on-stone knock (reads through the kick it is quantised onto) + short crack
        knock = sum(a * np.sin(2 * np.pi * fr * tt) * np.exp(-tt / d) for fr, a, d in [(930, 1, .03), (1520, .7, .02), (2480, .45, .012)])
        crack = (np.fft.irfft(np.fft.rfft(rng.standard_normal(m)) * (np.fft.rfftfreq(m, 1 / SR) > 1500), m)) * np.exp(-tt / .006)
        add((1.2 * nz + .8 * body + 1.8 * knock + .8 * crack) * e['heavy'], f2s(e['f']), pan=(k % 3 - 1) * .15, gain=.55)
    cur[0] = 'tick'
    for f in sorted(set(ev['type'])):                         # typing ticks
        m = int(.002 * SR); tt = np.arange(m) / SR
        click = np.sin(2 * np.pi * 2000 * tt) * np.hanning(m)
        tail = onepole_lp(rng.standard_normal(int(.01 * SR)), 4000) * env_ad(int(.01 * SR), .0005, .002) * .4
        add(np.concatenate([click, tail]), f2s(f) + int(rng.integers(0, 200)), pan=rng.uniform(-.2, .2), gain=.30)
    cur[0] = 'glitch'
    # glitch buzz, quantised to the 120 BPM 16th grid (3.75 frames), one per slot, alternating pitch
    slots = sorted({int(round(f / 3.75)) for f in ev['glitch']})
    for j, sl in enumerate(slots):
        f = sl * 3.75; hz = [180, 240, 135][j % 3]
        m = int(.06 * SR); tt = np.arange(m) / SR
        sq = np.tanh(4 * np.sin(2 * np.pi * hz * tt)) * (.6 + .4 * (rng.random(m) > .3))
        add(sq * np.hanning(m) * .9 + onepole_lp(rng.standard_normal(m), 3000) * np.hanning(m) * .25, int(round(f / 30 * SR)), pan=rng.uniform(-.5, .5), gain=.12)
    cur[0] = 'pop'
    for f in ev['pop']:                                       # agent / stone pops
        m = int(.09 * SR); tt = np.arange(m) / SR
        add(np.sin(2 * np.pi * (520 + 700 * tt / .09) * tt) * env_ad(m, .003, .025), f2s(f), gain=.10)
    cur[0] = 'whoosh'
    for f in ev.get('whoosh', []):                            # whip-pan whoosh (v2), centred on the cut
        m = int(.34 * SR); tt = np.arange(m) / SR; u = tt / tt[-1]
        nz = rng.standard_normal(m); X = np.fft.rfft(nz); fr = np.fft.rfftfreq(m, 1 / SR)
        band = np.fft.irfft(X * np.exp(-((np.log(fr + 1) - np.log(1800)) ** 2) / .8), m)
        e = np.sin(np.pi * u) ** 2
        add(band * e * 3.0, f2s(f) - int(.08 * SR), pan=-.6, gain=.5); add(band * e * 3.0, f2s(f), pan=.6, gain=.35)
    cur[0] = 'ping'
    if 'hit' in ev:                                           # 'found it' ping: E6 + B6 bell
        m = int(1.0 * SR); tt = np.arange(m) / SR
        bell = sum(a * np.sin(2 * np.pi * fr * tt) * np.exp(-tt / d) for fr, a, d in [(1318.5, 1, .35), (1975.5, .5, .25), (3637, .15, .08)])
        add(bell * np.minimum(1, tt / .002), f2s(ev['hit']), pan=-.2, gain=.10)
    cur[0] = 'chime'
    m = int(2.2 * SR); tt = np.arange(m) / SR; ch = np.zeros(m)   # A-major chime on the title
    for fr, a in [(440, 1), (554.37, .8), (659.25, .7), (880, .35)]:
        ch += a * (np.sin(2 * np.pi * fr * tt) + .12 * np.sin(2 * np.pi * fr * 2.76 * tt) * np.exp(-tt / .15)) * np.exp(-tt / .55)
    ch *= np.minimum(1, tt / .004)
    t0 = f2s(ev.get('title', ev['chime']))
    add(ch, t0, pan=-.1, gain=.05); add(ch, t0 + int(.011 * SR), pan=.25, gain=.035)
    return layers


def duck_env(ev, dur=15.0):
    """music gain: -2.5 dB under heavy thuds, -3 dB under the title hit (10 ms attack, 80 ms hold, 300 ms release)"""
    n = int(round(dur * SR)); g_db = np.zeros(n); fps = ev['fps']
    hits = [(e['f'], -2.5) for e in ev['land'] if e['heavy'] >= .9] + [(ev.get('title', ev['chime']), -3.0)]
    tt = np.arange(int(.6 * SR)) / SR
    shape = np.where(tt < .01, tt / .01, np.where(tt < .09, 1.0, np.exp(-(tt - .09) / .3)))
    for f, d in hits:
        s = int(round(f / fps * SR)); m = min(len(shape), n - s)
        g_db[s:s + m] = np.minimum(g_db[s:s + m], d * shape[:m])
    return 10 ** (g_db / 20)
