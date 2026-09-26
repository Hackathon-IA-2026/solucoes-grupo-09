# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "scipy>=1.13"]
# ///
"""The reel's soundtrack, synthesised from the reel's own schedule.

    uv run scripts/showreel/score.py      # output/score.json → output/score.wav

Nothing here is a sample and nothing is timed by hand: render.mjs writes the
cue table reel.html renders from (window.SCORE) to output/score.json, and every
hit, whoosh and chord change below is placed from it. Retime a beat in
BEATS and the music moves with the picture.

Two decisions worth knowing before changing it:

- **The pulse takes its tempo from the cuts, per section.** A card, a region
  and a replay figure are each held for a slot of their own length (0.96 s,
  1.03 s, 0.90 s), so a single BPM would land a kick beside every cut rather
  than on it. Each section's grid is its slot over two — 115 to 133 BPM, a
  drift nobody hears across an impact, where a kick 80 ms off a cut is heard
  by everyone.
- **The harmony follows the selection.** Each region, card and figure is a
  chord of one progression in A minor (Am F C G, E for the tension before a
  turn), and the last hit resolves to A major on the logo.
"""

import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48_000
OUT = Path(__file__).parent / "output"
rng = np.random.default_rng(7)  # a fixed seed, so the same schedule is the same file

score = json.loads((OUT / "score.json").read_text())
AT, S, DUR = score["beats"], score["sched"], score["dur"]
N = int((DUR + 0.5) * SR)


# ── primitives ─────────────────────────────────────────────────────────────
def tt(dur):
    return np.arange(int(dur * SR)) / SR


def note(name):
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch, octave = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pitch] + 12 * (octave + 1) - 69) / 12)


def filt(x, kind, f, order=2):
    if kind == "band":
        sos = butter(order, [f[0], f[1]], btype="bandpass", fs=SR, output="sos")
    else:
        sos = butter(order, min(f, SR / 2 - 100), btype=kind, fs=SR, output="sos")
    return sosfilt(sos, x)


def sweep(x, kind, f0, f1, curve=1.0, chunk=256):
    """A filter whose cutoff moves: chunked, with the state carried across."""
    out = np.zeros_like(x)
    zi = None
    n = len(x)
    for i in range(0, n, chunk):
        k = (i / max(1, n - 1)) ** curve
        f = f0 * (f1 / f0) ** k
        sos = butter(2, min(f, SR / 2 - 200), btype=kind, fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2))
        out[i : i + chunk], zi = sosfilt(sos, x[i : i + chunk], zi=zi)
    return out


def noise(dur):
    return rng.standard_normal(int(dur * SR))


def saw(f, t, phase=0.0):
    return 2 * ((f * t + phase) % 1.0) - 1


class Bus:
    def __init__(self):
        self.x = np.zeros((2, N))

    def add(self, at, sig, gain=1.0, pan=0.0):
        i = int(at * SR)
        if i >= N or len(sig) == 0:
            return
        sig = sig[: N - i] * gain
        if sig.ndim == 1:
            left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
            self.x[0, i : i + len(sig)] += sig * left * 1.414
            self.x[1, i : i + len(sig)] += sig * right * 1.414
        else:
            self.x[:, i : i + sig.shape[1]] += sig[:, : N - i]


drums, bass, pad, fx, send = Bus(), Bus(), Bus(), Bus(), Bus()
kicks = []


# ── instruments ────────────────────────────────────────────────────────────
def kick(at, gain=1.0):
    t = tt(0.5)
    f = 44 + 110 * np.exp(-t / 0.045)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28)
    click = filt(noise(0.5), "high", 1500) * np.exp(-t / 0.004) * 0.35
    drums.add(at, np.tanh(2.2 * (body + click)) * 0.9, gain)
    kicks.append(at)


def hat(at, gain=0.25, pan=0.25):
    t = tt(0.08)
    drums.add(at, filt(noise(0.08), "high", 7500) * np.exp(-t / 0.014), gain, pan)


def clap(at, gain=0.5):
    t = tt(0.3)
    burst = sum(np.roll(np.exp(-t / 0.006), int(d * SR)) for d in (0, 0.011, 0.022))
    body = filt(noise(0.3), "band", (900, 2600)) * (burst * 0.6 + np.exp(-t / 0.09))
    drums.add(at, body, gain)
    send.add(at, body, gain * 0.35)


def impact(at, gain=1.0, dur=2.6):
    t = tt(dur)
    f = 26 + 38 * np.exp(-t / 0.35)
    sub = np.tanh(1.8 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * np.exp(-t / 0.9)
    crack = filt(noise(dur), "low", 3200) * np.exp(-t / 0.18)
    air = filt(noise(dur), "high", 2500) * np.exp(-t / 0.5) * 0.25
    left, right = sub + crack * 0.7 + air, sub + np.roll(crack, 90) * 0.7 + np.roll(air, 200)
    fx.add(at, np.stack([left, right]) * 0.8, gain)
    send.add(at, (crack + air) * 0.6, gain)
    kick(at, 0.8 * gain)


def whoosh(at, dur, gain=0.55, up=True, pan=(-0.7, 0.7)):
    x = np.linspace(0, 1, int(dur * SR))
    env = np.sin(np.pi * np.clip(x, 0, 1) ** 0.7) ** 1.6
    body = sweep(noise(dur), "low", 400 if up else 6000, 6000 if up else 300, 1.2) * env
    angle = (pan[0] + (pan[1] - pan[0]) * x + 1) * np.pi / 4  # the whoosh travels across the field
    fx.add(at, np.stack([body * np.cos(angle), body * np.sin(angle)]) * 1.4, gain)
    send.add(at, body, gain * 0.3)


def riser(at, dur, gain=0.5):
    x = np.linspace(0, 1, int(dur * SR))
    rate = 4 + 28 * x**2
    trem = 0.55 + 0.45 * np.sin(2 * np.pi * np.cumsum(rate) / SR)
    tone = np.sin(2 * np.pi * np.cumsum(110 * 8**x) / SR)
    hiss = sweep(noise(dur), "high", 300, 9000, 1.5)
    sig = (tone * 0.5 + hiss * 0.6) * x**2.2 * trem
    fx.add(at, sig, gain)
    send.add(at, sig, gain * 0.4)


def rev_cymbal(at, dur, gain=0.45):
    x = np.linspace(0, 1, int(dur * SR))
    sig = filt(noise(dur), "high", 3500) * x**3
    fx.add(at, np.stack([sig, np.roll(sig, 40)]), gain)


def tick(at, f=3200, gain=0.3, pan=0.0):
    t = tt(0.05)
    fx.add(at, np.sin(2 * np.pi * f * t) * np.exp(-t / 0.01), gain, pan)


def ui_click(at, gain=0.5):
    tick(at, 2600, gain)
    tick(at + 0.07, 1900, gain * 0.7)


def pluck(at, f, gain=0.25, dur=1.2, pan=0.0):
    t = tt(dur)
    sig = sum(np.sin(2 * np.pi * k * f * t) / k * np.exp(-t * (2.5 + 1.8 * k)) for k in range(1, 9))
    fx.add(at, sig, gain, pan)
    send.add(at, sig, gain * 0.6)


def zap(at, gain=0.4):
    t = tt(0.28)
    f = 120 + 1700 * np.exp(-t / 0.05)
    sig = np.tanh(3 * (2 * ((np.cumsum(f) / SR) % 1) - 1)) * np.exp(-t / 0.09)
    fx.add(at, filt(sig, "low", 5000), gain)


def glitch(at, gain=0.35):
    for i in range(9):
        d = 0.018 + 0.03 * rng.random()
        t = tt(d)
        f = rng.choice([220, 330, 440, 880, 1320])
        sq = np.sign(np.sin(2 * np.pi * f * t)) * (0.5 + 0.5 * rng.random())
        crushed = np.round(noise(d) * 3) / 3 * 0.4
        fx.add(at + i * 0.042, (sq * 0.6 + crushed) * np.hanning(len(t)) ** 0.3, gain, rng.uniform(-0.8, 0.8))


def chord(at, dur, names, gain=0.12, bright=1800, attack=0.25, release=0.5):
    """Detuned saws through a low-pass: the pad under every section."""
    t = tt(dur + release)
    env = np.minimum(1, t / attack) * np.where(t > dur, np.exp(-(t - dur) / (release / 3)), 1)
    left = np.zeros_like(t)
    right = np.zeros_like(t)
    for name in names:
        f = note(name)
        for d, side in zip((-0.11, -0.04, 0.0, 0.05, 0.12), (0, 1, 0, 1, 0), strict=True):
            v = saw(f * 2 ** (d / 12), t, rng.random())
            (left if side == 0 else right)[:] += v
    left, right = filt(left, "low", bright), filt(right, "low", bright)
    pad.add(at, np.stack([left, right]) * env, gain / len(names))
    send.add(at, (left + right) * env * 0.5, gain / len(names) * 0.4)


def bassline(a, b, root, period, gain=0.5):
    """Eighths on the root, a filtered saw with a sub under it."""
    f = note(root)
    t0 = a
    while t0 < b - 0.02:
        d = min(period * 0.9, b - t0)
        t = tt(d)
        env = np.exp(-t / (period * 0.6))
        sig = sweep(saw(f, t), "low", 1300, 420, 0.3) * 0.6 + np.sin(2 * np.pi * f * t) * 0.8
        bass.add(t0, sig * env, gain)
        t0 += period


def grid(a, b, beat, snare=True, hats=True, gain=1.0):
    """Kick on every beat, clap on the second of each pair, hats between."""
    i, t0 = 0, a
    while t0 < b - 0.01:
        kick(t0, 0.85 * gain)
        if snare and i % 2 == 1:
            clap(t0, 0.45 * gain)
        if hats:
            hat(t0 + beat / 2, 0.22 * gain)
        i, t0 = i + 1, t0 + beat


def drone(a, b, names, gain=0.18):
    t = tt(b - a)
    env = np.minimum(1, t / 0.4) * np.minimum(1, (b - a - t) / 0.4 + 0.001)
    sig = sum(np.sin(2 * np.pi * note(n) * t + rng.random()) for n in names)
    wind = sweep(noise(b - a), "low", 200, 900, 1.0) * 0.3
    bass.add(a, (sig * 0.6 + wind) * env, gain)


# ── the arrangement ────────────────────────────────────────────────────────
PROG = {"Am": ["A2", "C3", "E3", "A3"], "F": ["F2", "A2", "C3", "F3"], "C": ["C3", "E3", "G3", "C4"],
        "G": ["G2", "B2", "D3", "G3"], "E": ["E2", "G#2", "B2", "E3"], "Dm": ["D3", "F3", "A3", "D4"]}
ROOT = {"Am": "A1", "F": "F1", "C": "C2", "G": "G1", "E": "E1", "Dm": "D2"}
ARP = {"Am": ["A4", "C5", "E5"], "F": ["F4", "A4", "C5"], "C": ["C5", "E5", "G5"], "G": ["G4", "B4", "D5"], "E": ["E4", "G#4", "B4"]}

# 01 Problema — a drone, two stabs, the glitch on "depois", the counter, a riser
p, sp = AT["problem"], S["problem"]
drone(p["a"], p["b"], ["A1", "E2"], 0.22)
impact(sp["p1"], 0.55, 2.0)
impact(sp["p2"], 0.6, 1.6)
glitch(sp["p2"] + 0.25)
impact(sp["n0"], 0.75, 2.0)
for i in range(18):  # the figure counts up on an out-expo curve: ticks crowd the start
    k = i / 18
    at = sp["n0"] - np.log2(1 - k * 0.999) / 10 * 0.9
    tick(float(at), 2200 + 90 * i, 0.22, (i % 2) * 0.6 - 0.3)
riser(p["b"] - 1.0, 1.0, 0.55)
rev_cymbal(p["b"] - 0.55, 0.55, 0.5)

# 02 Solução — the lift: a big hit as the hero swings in, C major, a shimmer
so = AT["solution"]
impact(so["a"] - 0.05, 1.0)
whoosh(so["a"] - 0.1, 0.9, 0.6)
chord(so["a"], so["d"], ["C3", "E3", "G3", "B3", "E4"], 0.16, 2600, 0.8)
bassline(so["a"] + 0.9, so["b"], "C2", 0.5, 0.35)
for i, n in enumerate(["C5", "E5", "G5", "B5", "E6"]):
    pluck(S["solution"]["sweep"] + i * 0.08, note(n), 0.12, 1.5, -0.6 + 0.3 * i)
for i in range(6):
    hat(so["b"] - 1.5 + i * 0.25, 0.1 + 0.03 * i)
riser(so["b"] - 0.8, 0.8, 0.35)
whoosh(so["b"] - 0.25, 0.4, 0.5, up=False)

# 03 Mapa — a chord per region, a pluck on each switch, the pulse on the cuts
m, sm = AT["map"], S["map"]
impact(m["a"], 0.8)
for i, name in enumerate(["Am", "F", "C", "G"]):
    a = sm["t0"] + i * sm["slot"]
    b = a + sm["slot"] if i < 3 else m["b"]
    chord(a, b - a, PROG[name], 0.14, 1600 + 250 * i, 0.05, 0.25)
    bassline(a, b, ROOT[name], sm["slot"] / 4, 0.45)
    grid(a, b, sm["slot"] / 2, snare=True, hats=True, gain=0.8)
    for j, n in enumerate(ARP[name]):
        pluck(a + j * 0.06, note(n), 0.16, 0.9, -0.4 + 0.4 * j)
    tick(a, 4200, 0.18)
chord(m["a"], sm["t0"] - m["a"], PROG["Am"], 0.1, 1400, 0.1, 0.1)

# 04 Cinco perguntas — a whoosh on every whip, a hit where each card lands
c, sc = AT["cards"], S["cards"]
impact(c["a"], 0.7, 1.8)
for i, name in enumerate(["Am", "F", "C", "G", "E"]):
    a = sc["t0"] + i * sc["slot"]
    b = a + sc["slot"]
    whoosh(a, S["whip"] + 0.05, 0.45, pan=(-0.8, 0.8) if i % 2 == 0 else (0.8, -0.8))
    chord(a, sc["slot"], PROG[name], 0.13, 1900 + 200 * i, 0.04, 0.2)
    bassline(a, b, ROOT[name], sc["slot"] / 4, 0.5)
    grid(a, b, sc["slot"] / 2, gain=0.95)
    tick(a + S["whip"] * 0.8, 3600, 0.22)
    pluck(a + S["whip"] * 0.8, note(ARP[name][2]), 0.12, 0.8)
whoosh(c["b"] - sc["out"], sc["out"] + 0.05, 0.5, up=False)

# 05 Explicar · O que fazer — the clicks, the drawer blooming open, half time
d, sd = AT["drawers"], S["drawers"]
for j, (name, opened) in enumerate(zip(["Dm", "F"], sd["opens"], strict=True)):
    a, b = opened - 0.3, opened - 0.3 + sd["half"]
    if j == 1:
        whoosh(a - 0.02, 0.3, 0.4, up=False)
    ui_click(opened - 0.07, 0.55)
    whoosh(opened, 0.55, 0.45)
    impact(opened + 0.02, 0.45, 1.6)
    chord(opened, b - opened, PROG[name], 0.15, 2200, 0.3, 0.3)
    bassline(opened, b, ROOT[name], sd["half"] / 8, 0.35)
    grid(opened, b, sd["half"] / 4, snare=False, hats=True, gain=0.55)

# 06 Máquina do tempo — the tab, a reverse swell into the dive, the full drop
r, sr_ = AT["replay"], S["replay"]
whoosh(r["a"], 0.32, 0.45)
ui_click(sr_["press"] + 0.05, 0.55)
rev_cymbal(sr_["press"], sr_["land"] - sr_["press"], 0.6)
riser(sr_["press"] - 0.2, sr_["land"] - sr_["press"] + 0.2, 0.45)
impact(sr_["land"], 1.0)
chord(sr_["land"], sr_["t0"] - sr_["land"], PROG["Am"], 0.12, 1500, 0.05, 0.1)
for i, name in enumerate(["Am", "F", "C", "G", "E"]):
    a = sr_["t0"] + i * sr_["slot"]
    b = a + sr_["slot"] if i < 4 else sr_["back"]
    whoosh(a, S["whip"], 0.4, pan=(-0.8, 0.8) if i % 2 == 0 else (0.8, -0.8))
    chord(a, b - a, PROG[name], 0.14, 2100 + 250 * i, 0.04, 0.2)
    bassline(a, b, ROOT[name], sr_["slot"] / 4, 0.5)
    grid(a, b, sr_["slot"] / 2, gain=1.0)
    tick(a + S["whip"] * 0.8, 3600, 0.22)
riser(sr_["back"] - 0.9, 0.9 + (r["b"] - sr_["back"]), 0.55)
rev_cymbal(r["b"] - 0.5, 0.5, 0.55)
whoosh(sr_["back"], r["b"] - sr_["back"], 0.45, up=False)

# 07 Tese — three clauses, and the harmony climbs with them: F under the
# estimate, C under the explanation, G under the decision, so the chord that
# resolves to A minor is the one the operator is standing on. Sparse on
# purpose — the card is read, not danced to.
th, sth = AT["thesis"], S["thesis"]
impact(th["a"], 0.85, 2.0)
whoosh(th["a"] - 0.1, 0.7, 0.45)
for key, cue in (("F", sth["l1"]), ("C", sth["l2"]), ("G", sth["l3"])):
    nxt = {"F": sth["l2"], "C": sth["l3"], "G": th["b"]}[key]
    chord(cue, nxt - cue, PROG[key], 0.13, 1500, 0.25, 0.3)
    tick(cue, 3400, 0.16)
    pluck(cue, note(ARP[key][0]), 0.14, 1.1)
bassline(sth["l1"], th["b"], ROOT["F"], 0.55, 0.3)
riser(th["b"] - 0.7, 0.7, 0.3)

# 08 — everything drops, "Não é vitamina", the strike, "É analgésico",
# a breath, then the resolution to A major under the logo
o, so_ = AT["outro"], S["outro"]
impact(o["a"], 1.0, 2.2)
impact(so_["v"], 0.55, 1.2)
impact(so_["v"] + 0.2, 0.6, 1.4)
zap(so_["v"] + 0.4, 0.45)
chord(so_["v"], so_["g"] - so_["v"], PROG["E"], 0.1, 900, 0.3, 0.3)
tick(so_["g"] + 0.05, 3000, 0.2)
chord(so_["g"], so_["l"] - so_["g"], ["A2", "E3", "B3"], 0.1, 1200, 0.5, 0.1)
riser(so_["g"] + 0.1, so_["l"] - so_["g"] - 0.14, 0.4)
impact(so_["l"], 1.2, 3.0)
chord(so_["l"], DUR - so_["l"], ["A2", "E3", "A3", "C#4", "E4", "B4"], 0.22, 3200, 0.02, 1.2)
for i, n in enumerate(["A5", "C#6", "E6", "B6"]):
    pluck(so_["l"] + 0.12 + i * 0.09, note(n), 0.13, 2.0, -0.5 + 0.33 * i)


# ── mix ────────────────────────────────────────────────────────────────────
t = np.arange(N) / SR
duck = np.ones(N)
for k in kicks:  # side-chain: the pad and the bass breathe with every kick
    i = int(k * SR)
    seg = np.arange(N - i) / SR
    duck[i:] *= 1 - 0.55 * np.exp(-seg / 0.11)

ir_t = tt(2.4)
ir = np.stack([filt(noise(2.4), "low", 6000) * np.exp(-ir_t / 0.55) for _ in range(2)]) * 0.04
wet = np.stack([fftconvolve(send.x[ch], ir[ch])[:N] for ch in range(2)])

mix = drums.x + (bass.x + pad.x) * duck + fx.x + wet * 0.9
mix = filt(mix, "high", 28)  # nothing below the sub is anything but rumble
fade = np.clip((DUR - t) / 0.35, 0, 1)
mix *= fade
# A gentle saturation only: at a drive of 2 the groove rose to meet the
# impacts and the hits stopped landing (LRA 4.2 LU). Loudness is set at the mux.
mix = np.tanh(1.1 * mix / (np.abs(mix).max() + 1e-9)) / np.tanh(1.1) * 0.89
wavfile.write(OUT / "score.wav", SR, (mix.T * 32767).astype(np.int16))
print(OUT / "score.wav", f"{DUR:.2f}s", f"{len(kicks)} kicks")
