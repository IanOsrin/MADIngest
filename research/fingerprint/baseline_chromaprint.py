"""research/fingerprint/baseline_chromaprint.py — what we have to beat.

Scores the CURRENT detector (chromaprint raw fingerprints + the windowed
bit-similarity from DCMax scripts/server.py `_dcx_similarity`) against the
attack set, so every later change can be judged against a real number rather
than an impression.

The scoring is the same rule as the shipped one — best contiguous window of
per-frame bit similarity at the best alignment — but vectorised, because the
pure-Python loop would take days over 2,500 queries.

The reference index deliberately HOLDS BACK the last 20 tracks. Queries cut
from those are negatives: a detector that matches them is inventing matches,
and without them recall alone would reward saying yes to everything.

    python3 baseline_chromaprint.py            # fingerprint, then evaluate
    python3 baseline_chromaprint.py --fp-only  # just build the fingerprints

Writes results.csv and baseline-summary.json to the lab directory.
"""
import json, os, subprocess, sys, csv
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

LAB = Path(os.environ.get("FP_LAB", "/Volumes/Bandlab/fingerprint-lab"))
REFS, QUERIES = LAB / "refs", LAB / "queries"
FP_CACHE = LAB / "fingerprints.json"
HELD_BACK = 20          # tracks kept out of the index, to measure false positives
WINDOW = 160            # frames (~20 s), same as the shipped matcher
MIN_FRAMES = 24         # ~3 s, same as the shipped matcher
THRESHOLDS = {"strong": 0.72, "clear": 0.62, "buried": 0.55}


def fpcalc(path: Path, length: int):
    """Raw chromaprint frames for a file, or None when it can't be read."""
    try:
        out = subprocess.run(
            ["fpcalc", "-raw", "-length", str(length), str(path)],
            capture_output=True, text=True, timeout=120, check=True).stdout
    except Exception:
        return None
    for line in out.splitlines():
        if line.startswith("FINGERPRINT="):
            return [int(x) for x in line[12:].split(",") if x]
    return None


def _fp_job(args):
    path, length = args
    return str(path), fpcalc(Path(path), length)


def build_fingerprints():
    corpus = json.loads((LAB / "corpus.json").read_text())
    queries = json.loads((LAB / "queries.json").read_text())
    jobs = [(str(REFS / f"{r['filename']}.mp3"), 300) for r in corpus
            if (REFS / f"{r['filename']}.mp3").exists()]
    jobs += [(str(QUERIES / q["file"]), 30) for q in queries
             if (QUERIES / q["file"]).exists()]
    print(f"fingerprinting {len(jobs)} files…")
    out = {}
    with ProcessPoolExecutor() as ex:
        for i, (path, fp) in enumerate(ex.map(_fp_job, jobs, chunksize=8), 1):
            if fp:
                out[path] = fp
            if i % 250 == 0:
                print(f"  {i}/{len(jobs)}")
    FP_CACHE.write_text(json.dumps(out))
    print(f"{len(out)} fingerprints cached")
    return out


def best_similarity(a: np.ndarray, b: np.ndarray):
    """Best windowed bit similarity of query `a` against reference `b`.

    Mirrors _dcx_similarity: slide the query, score the best contiguous window
    of length min(160, len(a)), return (score, offset_frames).
    """
    if a.size < MIN_FRAMES or b.size < MIN_FRAMES:
        return 0.0, 0
    if a.size > b.size:
        a, b = b, a
    w = min(WINDOW, a.size)
    n = b.size - a.size + 1
    if n <= 0:
        return 0.0, 0
    # Sliding windows over the reference, one row per alignment.
    view = np.lib.stride_tricks.sliding_window_view(b, a.size)
    sim = (32 - np.bitwise_count(view ^ a[None, :]).astype(np.float32)) / 32.0
    if w == a.size:
        means = sim.mean(axis=1)
    else:
        # Best contiguous w-frame stretch within each alignment.
        csum = np.cumsum(np.concatenate([np.zeros((sim.shape[0], 1), np.float32), sim], axis=1), axis=1)
        means = ((csum[:, w:] - csum[:, :-w]) / w).max(axis=1)
    i = int(means.argmax())
    return float(means[i]), i


def _eval_job(args):
    qfile, qfp, ref_items = args
    q = np.array(qfp, dtype=np.uint32)
    best_name, best_score, best_off = None, 0.0, 0
    for name, fp in ref_items:
        s, off = best_similarity(q, fp)
        if s > best_score:
            best_name, best_score, best_off = name, s, off
    return qfile, best_name, best_score, best_off


def main():
    fps = json.loads(FP_CACHE.read_text()) if FP_CACHE.exists() else build_fingerprints()
    if "--fp-only" in sys.argv:
        return

    corpus = json.loads((LAB / "corpus.json").read_text())
    queries = json.loads((LAB / "queries.json").read_text())
    indexed = [r["filename"] for r in corpus[:-HELD_BACK]]
    held = set(r["filename"] for r in corpus[-HELD_BACK:])

    ref_items = []
    for name in indexed:
        fp = fps.get(str(REFS / f"{name}.mp3"))
        if fp:
            ref_items.append((name, np.array(fp, dtype=np.uint32)))
    print(f"index: {len(ref_items)} tracks · held back: {len(held)} · queries: {len(queries)}")

    jobs = []
    for q in queries:
        fp = fps.get(str(QUERIES / q["file"]))
        if fp:
            jobs.append((q["file"], fp, ref_items))
    print(f"scoring {len(jobs)} queries…")

    by_file = {q["file"]: q for q in queries}
    rows = []
    with ProcessPoolExecutor() as ex:
        for i, (qfile, match, score, off) in enumerate(ex.map(_eval_job, jobs, chunksize=4), 1):
            meta = by_file[qfile]
            truth = meta["filename"]
            rows.append({
                "file": qfile, "attack": meta["attack"], "truth": truth,
                "held_back": truth in held, "match": match or "",
                "score": round(score, 4), "offset_frames": off,
                "correct": bool(match == truth),
            })
            if i % 200 == 0:
                print(f"  {i}/{len(jobs)}")

    with (LAB / "results.csv").open("w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        wr.writeheader()
        wr.writerows(rows)

    # ── report ──────────────────────────────────────────────────────────────
    positives = [r for r in rows if not r["held_back"]]
    negatives = [r for r in rows if r["held_back"]]
    summary = {"index_size": len(ref_items), "queries": len(rows), "by_attack": {}, "thresholds": {}}

    print(f"\n{'attack':<12}{'n':>5}{'found@.55':>11}{'@.62':>8}{'@.72':>8}{'median':>9}")
    attacks = sorted(set(r["attack"] for r in positives))
    for atk in attacks:
        sub = [r for r in positives if r["attack"] == atk]
        hit = lambda t: sum(1 for r in sub if r["correct"] and r["score"] >= t) / len(sub)
        med = float(np.median([r["score"] for r in sub]))
        summary["by_attack"][atk] = {
            "n": len(sub), "recall_055": hit(0.55), "recall_062": hit(0.62),
            "recall_072": hit(0.72), "median_score": round(med, 4),
        }
        print(f"{atk:<12}{len(sub):>5}{hit(0.55):>10.0%}{hit(0.62):>8.0%}{hit(0.72):>8.0%}{med:>9.3f}")

    print(f"\nnegatives (queries from the {len(held)} held-back tracks): {len(negatives)}")
    for label, t in THRESHOLDS.items():
        fp_rate = sum(1 for r in negatives if r["score"] >= t) / max(1, len(negatives))
        tp_rate = sum(1 for r in positives if r["correct"] and r["score"] >= t) / max(1, len(positives))
        summary["thresholds"][label] = {"threshold": t, "recall": tp_rate, "false_positive_rate": fp_rate}
        print(f"  at {t:.2f} ({label}): recall {tp_rate:.1%} · false positives {fp_rate:.1%}")

    (LAB / "baseline-summary.json").write_text(json.dumps(summary, indent=1))
    print(f"\nwritten: {LAB}/results.csv and baseline-summary.json")


if __name__ == "__main__":
    main()
