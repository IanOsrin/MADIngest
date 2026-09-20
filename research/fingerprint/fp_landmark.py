"""research/fingerprint/fp_landmark.py — landmark ("constellation") fingerprints.

The idea, which is how Shazam works and why it beats chromaprint on damaged
audio: instead of summarising the whole signal, keep only the LOUDEST POINTS of
the spectrogram — peaks that survive EQ, mp3, noise and being mixed under
something else, because a peak stays a peak when you add other sound around it.

Each peak is paired with a few later peaks, and each pair becomes one integer:

    (frequency of the first, frequency step to the second, time between them)

Those integers go in a dictionary, hash -> [(track, time)]. Matching a query is
then a lookup, not a comparison against every track: shared hashes vote, and a
real match puts most of its votes at ONE time offset (the clip's position in the
track). Coincidental hashes scatter across offsets and cancel out, which is what
makes the score trustworthy.

Deliberately NOT here: pitch invariance. A pitch shift moves every peak, so the
hashes change and this design misses it — as the baseline does. That is the next
experiment (query-side pitch sweep, or a hash built from frequency RATIOS);
measuring the plain version first is what tells us how much each idea buys.

    python3 fp_landmark.py index      # build the index from refs/
    python3 fp_landmark.py eval       # score the attack set, print the table
    python3 fp_landmark.py match FILE # identify one file
"""
import json, os, pickle, subprocess, sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

LAB = Path(os.environ.get("FP_LAB", "/Volumes/Bandlab/fingerprint-lab"))
REFS, QUERIES = LAB / "refs", LAB / "queries"
INDEX_PATH = LAB / "landmark-index.pkl"
HELD_BACK = 20

# ── analysis settings ───────────────────────────────────────────────────────
SR = 11025          # the top 5 kHz holds the peaks that survive; less audio to chew
NFFT = 1024         # 93 ms window: fine enough for beats, coarse enough to be stable
HOP = 256           # 23 ms between frames — also the resolution of a reported offset
PEAK_NEIGH_F = 9    # a peak must be the loudest in ±9 bins
PEAK_NEIGH_T = 9    # ...and in ±9 frames
PEAKS_PER_SEC = int(os.environ.get('FP_PEAKS', 28))  # density: robustness vs index size
FANOUT = int(os.environ.get('FP_FANOUT', 8))          # later peaks each anchor pairs with
DT_MIN, DT_MAX = 2, 64      # 46 ms .. 1.5 s apart
DF_MAX = 63                 # pairs must be within ±63 bins (~680 Hz)


def decode(path, sr=SR):
    """Mono float32 at SR, straight out of ffmpeg — it reads everything."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True, timeout=300, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def spectrogram(x):
    """Log-magnitude STFT, frames as rows."""
    if x.size < NFFT:
        return np.zeros((0, NFFT // 2 + 1), np.float32)
    n = 1 + (x.size - NFFT) // HOP
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(n, NFFT), strides=(x.strides[0] * HOP, x.strides[0]))
    win = np.hanning(NFFT).astype(np.float32)
    spec = np.abs(np.fft.rfft(frames * win, axis=1)).astype(np.float32)
    return np.log1p(spec * 100.0)


def peaks(S):
    """The loudest points of the spectrogram: (time_frame, freq_bin) pairs.

    A point survives when it is the maximum of its neighbourhood — computed with
    two sliding-window maxima rather than a 2-D filter, since scipy isn't here.
    Then the list is thinned to a fixed rate so a loud track and a quiet one
    contribute the same number of landmarks.
    """
    if S.shape[0] < 3:
        return np.zeros((0, 2), np.int32)
    pad = lambda A, w, axis: np.pad(A, [(w, w) if i == axis else (0, 0) for i in range(2)], mode="edge")
    # max over time, then over frequency == max over the rectangle
    mt = np.lib.stride_tricks.sliding_window_view(
        pad(S, PEAK_NEIGH_T, 0), 2 * PEAK_NEIGH_T + 1, axis=0).max(axis=-1)
    mf = np.lib.stride_tricks.sliding_window_view(
        pad(mt, PEAK_NEIGH_F, 1), 2 * PEAK_NEIGH_F + 1, axis=1).max(axis=-1)
    is_peak = (S >= mf) & (S > np.percentile(S, 55))
    t, f = np.nonzero(is_peak)
    if t.size == 0:
        return np.zeros((0, 2), np.int32)
    # Thin to PEAKS_PER_SEC by keeping the strongest per short time slice.
    seconds = max(1.0, S.shape[0] * HOP / SR)
    keep = int(PEAKS_PER_SEC * seconds)
    if t.size > keep:
        strength = S[t, f]
        idx = np.argpartition(strength, -keep)[-keep:]
        t, f = t[idx], f[idx]
    # Bin 512 (Nyquist) would need a tenth bit and overflow the hash packing —
    # it carries nothing useful at 11 kHz anyway.
    inside = f <= 511
    t, f = t[inside], f[inside]
    order = np.argsort(t)
    return np.stack([t[order], f[order]], axis=1).astype(np.int32)


def hashes(pk):
    """Peak pairs as integers, with the time of the first peak.

    Packing: f1 (9 bits) | df+64 (7 bits) | dt (6 bits). Two peaks an octave
    apart at the same spacing give a different number, which is what makes a
    match specific — and also why a pitch shift breaks it.
    """
    out_h, out_t = [], []
    n = len(pk)
    for i in range(n):
        t1, f1 = pk[i]
        j = i + 1
        pairs = 0
        while j < n and pairs < FANOUT:
            t2, f2 = pk[j]
            dt = int(t2) - int(t1)
            if dt < DT_MIN:
                j += 1
                continue
            if dt > DT_MAX:
                break
            df = int(f2) - int(f1)
            if abs(df) <= DF_MAX:
                out_h.append((int(f1) << 13) | ((df + 64) << 6) | dt)
                out_t.append(int(t1))
                pairs += 1
            j += 1
    return np.array(out_h, np.int64), np.array(out_t, np.int32)


def hashes_scaled(pk, ratio):
    """The same pairing, with every peak's frequency scaled by `ratio`.

    A pitch shift multiplies frequencies, so undoing one is a multiply — and
    since the peaks are already found, this costs only the re-pairing. Emulating
    the shift on the LANDMARKS rather than re-rendering the audio is what makes
    a sweep affordable: five pitches for the price of one decode.
    """
    if ratio == 1.0:
        return hashes(pk)
    scaled = pk.copy()
    f = np.rint(pk[:, 1].astype(np.float64) * ratio)
    keep = (f >= 0) & (f <= 511)          # 9 bits of frequency in the hash
    scaled = scaled[keep]
    scaled[:, 1] = f[keep].astype(np.int32)
    return hashes(scaled)


# Semitone steps to try on the QUERY side. A sampler's pitch move is usually a
# whole number of semitones; half-steps in between cost little and catch tape
# speed and turntable pitch, which land anywhere.
SWEEP = [-2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0]


def fingerprint_file(path):
    return hashes(peaks(spectrogram(decode(path))))


def peaks_for_file(path):
    return peaks(spectrogram(decode(path)))


def _index_job(args):
    name, path = args
    try:
        h, t = fingerprint_file(path)
        return name, h, t
    except Exception as e:
        print(f"  {name}: {e}")
        return name, np.array([], np.int64), np.array([], np.int32)


def build_index():
    corpus = json.loads((LAB / "corpus.json").read_text())
    indexed = [r["filename"] for r in corpus[:-HELD_BACK]]
    jobs = [(n, str(REFS / f"{n}.mp3")) for n in indexed if (REFS / f"{n}.mp3").exists()]
    print(f"indexing {len(jobs)} tracks…")

    table = defaultdict(list)          # hash -> [(track_id, time_frame)]
    names, total = [], 0
    with ProcessPoolExecutor() as ex:
        for i, (name, h, t) in enumerate(ex.map(_index_job, jobs, chunksize=2), 1):
            tid = len(names)
            names.append(name)
            for hh, tt in zip(h.tolist(), t.tolist()):
                table[hh].append((tid, tt))
            total += h.size
            if i % 25 == 0:
                print(f"  {i}/{len(jobs)} · {total:,} hashes · {len(table):,} distinct")

    # Freeze to arrays: smaller, and lookup returns a view rather than a list.
    frozen = {h: np.array(v, np.int32) for h, v in table.items()}
    INDEX_PATH.write_bytes(pickle.dumps({"names": names, "table": frozen}, protocol=4))
    print(f"\n{len(names)} tracks · {total:,} hashes · {len(frozen):,} distinct · "
          f"{INDEX_PATH.stat().st_size / 1e6:.0f} MB")


def load_index():
    d = pickle.loads(INDEX_PATH.read_bytes())
    return d["names"], d["table"]


def match(qh, qt, names, table, top=3):
    """Vote: shared hashes at a consistent time offset are the match.

    Returns [(track, votes, offset_seconds, share_of_query_hashes)], best first.
    """
    votes = defaultdict(int)
    for h, t in zip(qh.tolist(), qt.tolist()):
        post = table.get(h)
        if post is None:
            continue
        if len(post) > 400:            # a hash in hundreds of tracks says nothing
            continue
        for tid, tt in post:
            votes[(tid, tt - t)] += 1
    if not votes:
        return []
    best = defaultdict(int)
    where = {}
    for (tid, off), c in votes.items():
        if c > best[tid]:
            best[tid], where[tid] = c, off
    ranked = sorted(best.items(), key=lambda kv: -kv[1])[:top]
    denom = max(1, qh.size)
    return [(names[tid], c, where[tid] * HOP / SR, c / denom) for tid, c in ranked]


def _eval_job(args):
    qfile, path = args
    try:
        qh, qt = fingerprint_file(path)
        return qfile, qh, qt
    except Exception:
        return qfile, np.array([], np.int64), np.array([], np.int32)


# ── pitch sweep ─────────────────────────────────────────────────────────────
# Worker-side matching: the index is big, so each process loads it once rather
# than shipping hashes back and forth.
_W = {}


def _sweep_init():
    _W["names"], _W["table"] = load_index()


def _sweep_job(args):
    qfile, path = args
    try:
        pk = peaks_for_file(path)
    except Exception:
        return qfile, ("", 0, 0.0, 0.0), 0.0
    best, best_semi = ("", 0, 0.0, 0.0), 0.0
    for semi in SWEEP:
        h, t = hashes_scaled(pk, 2.0 ** (-semi / 12.0))
        res = match(h, t, _W["names"], _W["table"], top=1)
        if res and res[0][1] > best[1]:
            best, best_semi = res[0], semi
    return qfile, best, best_semi


def evaluate_sweep():
    corpus = json.loads((LAB / "corpus.json").read_text())
    held = set(r["filename"] for r in corpus[-HELD_BACK:])
    queries = [q for q in json.loads((LAB / "queries.json").read_text())
               if (QUERIES / q["file"]).exists()]
    print(f"pitch sweep {SWEEP} semitones · {len(queries)} queries")

    jobs = [(q["file"], str(QUERIES / q["file"])) for q in queries]
    by_file = {q["file"]: q for q in queries}
    rows = []
    with ProcessPoolExecutor(initializer=_sweep_init) as ex:
        for i, (qfile, top, semi) in enumerate(ex.map(_sweep_job, jobs, chunksize=8), 1):
            meta = by_file[qfile]
            rows.append({
                "file": qfile, "attack": meta["attack"], "truth": meta["filename"],
                "held_back": meta["filename"] in held, "match": top[0], "votes": top[1],
                "offset_s": round(top[2], 2), "share": round(top[3], 4),
                "semitones": semi, "correct": top[0] == meta["filename"],
            })
            if i % 250 == 0:
                print(f"  {i}/{len(jobs)}")
    (LAB / "landmark-sweep-results.json").write_text(json.dumps(rows, indent=1))
    report(rows, held_n=len(held))
    # Did the sweep find the shift that was actually applied?
    for atk in ("pitch_p2", "pitch_m2"):
        sub = [r for r in rows if r["attack"] == atk and r["correct"]]
        if sub:
            picked = {}
            for r in sub:
                picked[r["semitones"]] = picked.get(r["semitones"], 0) + 1
            print(f"{atk}: chosen shift " + " ".join(f"{k:+g}:{v}" for k, v in sorted(picked.items())))


def evaluate():
    names, table = load_index()
    corpus = json.loads((LAB / "corpus.json").read_text())
    held = set(r["filename"] for r in corpus[-HELD_BACK:])
    queries = [q for q in json.loads((LAB / "queries.json").read_text())
               if (QUERIES / q["file"]).exists()]
    print(f"index: {len(names)} tracks · queries: {len(queries)}")

    jobs = [(q["file"], str(QUERIES / q["file"])) for q in queries]
    by_file = {q["file"]: q for q in queries}
    rows = []
    with ProcessPoolExecutor() as ex:
        for i, (qfile, qh, qt) in enumerate(ex.map(_eval_job, jobs, chunksize=8), 1):
            res = match(qh, qt, names, table)
            meta = by_file[qfile]
            top = res[0] if res else ("", 0, 0.0, 0.0)
            rows.append({
                "file": qfile, "attack": meta["attack"], "truth": meta["filename"],
                "held_back": meta["filename"] in held, "match": top[0], "votes": top[1],
                "offset_s": round(top[2], 2), "share": round(top[3], 4),
                "correct": top[0] == meta["filename"],
                "runner_up": res[1][1] if len(res) > 1 else 0,
            })
            if i % 250 == 0:
                print(f"  {i}/{len(jobs)}")

    (LAB / "landmark-results.json").write_text(json.dumps(rows, indent=1))
    report(rows, held_n=len(held))


def report(rows, held_n=HELD_BACK):
    pos = [r for r in rows if not r["held_back"]]
    neg = [r for r in rows if r["held_back"]]
    # A vote threshold is the decision: how many aligned hashes before we believe it.
    thresholds = [3, 5, 8, 12, 20]
    print(f"\n{'attack':<12}{'n':>5}" + "".join(f"{'≥' + str(t):>7}" for t in thresholds) + f"{'med votes':>11}")
    for atk in sorted(set(r["attack"] for r in pos)):
        sub = [r for r in pos if r["attack"] == atk]
        cells = "".join(f"{sum(1 for r in sub if r['correct'] and r['votes'] >= t) / len(sub):>7.0%}"
                        for t in thresholds)
        med = int(np.median([r["votes"] for r in sub]))
        print(f"{atk:<12}{len(sub):>5}{cells}{med:>11}")
    print(f"\nnegatives ({held_n} held-back tracks, {len(neg)} queries):")
    for t in thresholds:
        rec = sum(1 for r in pos if r["correct"] and r["votes"] >= t) / max(1, len(pos))
        fp = sum(1 for r in neg if r["votes"] >= t) / max(1, len(neg))
        print(f"  ≥{t:>3} votes: recall {rec:>5.1%} · false positives {fp:>5.1%}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "eval"
    if cmd == "index":
        build_index()
    elif cmd == "eval":
        evaluate()
    elif cmd == "sweep":
        evaluate_sweep()
    elif cmd == "report":
        report(json.loads((LAB / "landmark-results.json").read_text()))
    elif cmd == "match":
        names, table = load_index()
        qh, qt = fingerprint_file(sys.argv[2])
        for name, votes, off, share in match(qh, qt, names, table) or []:
            print(f"{name:<16} votes {votes:<5} at {off:7.2f}s  ({share:.1%} of query hashes)")
    else:
        print(__doc__)
