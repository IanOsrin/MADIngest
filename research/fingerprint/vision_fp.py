"""research/fingerprint/vision_fp.py — fingerprint Vision, one folder at a time.

Vision is Gallo's master store: an S3-compatible object store holding 202,070
WAVs (16.3 TB). It has no compute, and reads from here run at a few MB/s, so
reading whole files is out of the question — a month of transfer. Two facts
make it feasible anyway:

  1. WAV is uncompressed PCM, so a byte offset IS a time offset. A ranged GET
     of the middle 30 s of a track is ~5 MB, not 50, and a landmark fingerprint
     of 30 s is plenty to tell one recording from another.
  2. The same read serves the exact-duplicate question for free: the first
     256 KB (header + the opening audio) is hashed, and size + that hash is a
     byte-identical copy. Vision is full of those (2.85 TB by the index).

Ian directs which folders run (the store is too big to do blind), each run is
resumable, and NOTHING here writes to Vision — it is read-only by construction:
the client is only ever asked to GET.

    python3 vision_fp.py list                       # the folder menu, with sizes
    python3 vision_fp.py dry  --prefix "/bucket/folder/"
    python3 vision_fp.py run  --prefix "/bucket/folder/" [--prefix ...] [--workers 6]
    python3 vision_fp.py dups                       # exact copies (size + head hash)
    python3 vision_fp.py near [--min 20]            # same recording, different file
    python3 vision_fp.py stats

Everything lands under $FP_LAB/vision/ (default /Volumes/Bandlab/fingerprint-lab).
"""
import hashlib
import io
import json
import os
import re
import struct
import subprocess
import sys
import time
import warnings
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fp_landmark import spectrogram, peaks, hashes, SR, HOP  # noqa: E402

LAB = Path(os.environ.get("FP_LAB", "/Volumes/Bandlab/fingerprint-lab"))
OUT = LAB / "vision"
BUCKETS = OUT / "buckets"
MANIFEST = OUT / "manifest.jsonl"
INDEX_JSON = Path(__file__).resolve().parents[2] / "tmp" / "vision-index.json"
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

HEAD_BYTES = 256 * 1024          # header + opening audio: parsed, and hashed for exact dups
SLICE_SEC = 30                   # the middle 30 s is fingerprinted
N_BUCKETS = 64
BUCKET_SHIFT = 22 - 6            # hashes use 22 bits; the top 6 choose the bucket
ROW = np.dtype([("hash", np.uint32), ("track", np.uint32), ("time", np.uint16)])


# ── Vision access (read-only) ────────────────────────────────────────────────
def _env():
    """Pull the Vision keys out of GalloIngest's .env without sourcing it —
    sourcing the file clobbers PATH (learned the hard way, 2026-09-21)."""
    vals = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\s*(VISION_[A-Z_]+)\s*=\s*(.*?)\s*$", line)
        if m:
            vals[m.group(1)] = m.group(2).strip('"').strip("'")
    return vals


_client = None


def client():
    global _client
    if _client is None:
        import boto3
        from botocore.config import Config
        e = _env()
        if e.get("VISION_INSECURE_TLS", "").lower() == "true":
            warnings.filterwarnings("ignore", message="Unverified HTTPS request")
        _client = boto3.client(
            "s3",
            endpoint_url=e["VISION_ENDPOINT"],
            aws_access_key_id=e["VISION_ACCESS_KEY"],
            aws_secret_access_key=e["VISION_SECRET_KEY"],
            region_name=e.get("VISION_REGION", "us-east-1"),
            verify=not e.get("VISION_INSECURE_TLS", "").lower() == "true",
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 4},
                          connect_timeout=20, read_timeout=120),
        )
    return _client


def split_path(p):
    """'/bucket/a/b.wav' → ('bucket', 'a/b.wav')"""
    bucket, _, key = p.lstrip("/").partition("/")
    return bucket, key


def get_range(p, start, end_inclusive):
    b, k = split_path(p)
    r = client().get_object(Bucket=b, Key=k, Range=f"bytes={start}-{end_inclusive}")
    return r["Body"].read()


# ── the index we already hold ────────────────────────────────────────────────
def all_wavs():
    d = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
    for folder in d["folders"].values():
        for it in folder["files"]:
            if it["path"].lower().endswith(".wav"):
                yield it["path"], int(it["size"])


def select(prefixes):
    pre = tuple(prefixes)
    return [(p, s) for p, s in all_wavs() if p.startswith(pre)]


def folder_menu():
    d = json.loads(INDEX_JSON.read_text(encoding="utf-8"))
    rows = []
    for key, f in d["folders"].items():
        w = [it for it in f["files"] if it["path"].lower().endswith(".wav")]
        if w:
            rows.append((key, len(w), sum(i["size"] for i in w)))
    rows.sort(key=lambda r: -r[2])
    print(f"{'WAVs':>8}  {'TB':>6}  {'read est':>9}  prefix")
    for k, n, b in rows:
        est = n * (HEAD_BYTES + SLICE_SEC * 176_400)
        print(f"{n:8,}  {b/1e12:6.2f}  {est/1e9:7.1f} GB  /{k}/")


# ── WAV header ───────────────────────────────────────────────────────────────
def parse_wav(head):
    """Return (channels, rate, bits, fmt_tag, data_offset, data_size) from the
    first bytes of a WAV, or raise. Walks the chunks: fmt may not be first,
    and a LIST chunk often sits before data."""
    if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    pos, fmt = 12, None
    while pos + 8 <= len(head):
        cid = head[pos:pos + 4]
        csize = struct.unpack("<I", head[pos + 4:pos + 8])[0]
        body = pos + 8
        if cid == b"fmt ":
            tag, ch, rate, _, _, bits = struct.unpack("<HHIIHH", head[body:body + 16])
            if tag == 0xFFFE and csize >= 26:          # WAVE_FORMAT_EXTENSIBLE
                tag = struct.unpack("<H", head[body + 24:body + 26])[0]
            fmt = (ch, rate, bits, tag)
        elif cid == b"data":
            if fmt is None:
                raise ValueError("data chunk before fmt")
            return (*fmt, body, csize)
        pos = body + csize + (csize & 1)
    raise ValueError("no data chunk in the first %d KB" % (len(head) // 1024))


def pcm_format(bits, tag):
    if tag == 3:
        return {32: "f32le", 64: "f64le"}[bits]
    if tag != 1:
        raise ValueError(f"unsupported WAV format tag {tag}")
    return {8: "u8", 16: "s16le", 24: "s24le", 32: "s32le"}[bits]


def decode_pcm(raw, fmt, rate, ch):
    """Raw PCM bytes → mono float32 at SR, via ffmpeg (handles 24-bit and the
    resample properly; numpy alone would not)."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", fmt, "-ar", str(rate), "-ac", str(ch), "-i", "pipe:0",
         "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        input=raw, capture_output=True, timeout=120, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


# ── one track ────────────────────────────────────────────────────────────────
def fingerprint_one(args):
    """Two ranged reads, one fingerprint. Returns a manifest record plus the
    hash/time arrays, or a record carrying an error. Never raises."""
    idx, path, size = args
    rec = {"id": idx, "path": path, "size": size}
    try:
        head = get_range(path, 0, min(HEAD_BYTES, size) - 1)
        rec["head_sha"] = hashlib.sha256(head).hexdigest()
        ch, rate, bits, tag, data_off, data_size = parse_wav(head)
        block = ch * bits // 8
        if data_size in (0, 0xFFFFFFFF) or data_off + data_size > size:
            data_size = size - data_off                 # broken header: trust the object size
        n_frames = data_size // block
        dur = n_frames / rate
        rec.update(ch=ch, rate=rate, bits=bits, dur=round(dur, 2))

        want = min(int(SLICE_SEC * rate), n_frames)
        start_frame = max(0, (n_frames - want) // 2)
        a = data_off + start_frame * block
        b = a + want * block - 1
        rec["slice_start"] = round(start_frame / rate, 2)

        # The head read already covers the start of short tracks: reuse it.
        if b < len(head):
            raw = head[a:b + 1]
        else:
            raw = get_range(path, a, b)

        x = decode_pcm(raw, pcm_format(bits, tag), rate, ch)
        if x.size < SR * 3:
            raise ValueError(f"only {x.size / SR:.1f}s of audio decoded")
        h, t = hashes(peaks(spectrogram(x)))
        rec["n_hashes"] = int(h.size)
        return rec, h.astype(np.uint32), t.astype(np.uint16)
    except Exception as e:                               # noqa: BLE001 — recorded, run continues
        rec["error"] = f"{type(e).__name__}: {str(e)[:120]}"
        return rec, None, None


# ── manifest / resume ────────────────────────────────────────────────────────
def load_manifest():
    recs = []
    if MANIFEST.exists():
        for line in MANIFEST.read_text(encoding="utf-8").splitlines():
            if line.strip():
                recs.append(json.loads(line))
    return recs


def next_id(recs):
    return (max((r["id"] for r in recs), default=-1) + 1)


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_dry(prefixes):
    sel = select(prefixes)
    done = {r["path"] for r in load_manifest()}
    todo = [s for s in sel if s[0] not in done]
    est = len(todo) * (HEAD_BYTES + SLICE_SEC * 176_400)
    print(f"{len(sel):,} WAVs under {len(prefixes)} prefix(es); {len(todo):,} still to do")
    print(f"≈ {est/1e9:.1f} GB to read; at ~4 MB/s/stream × 6 streams ≈ {est/1e6/24/3600:.1f} h")


def cmd_run(prefixes, workers):
    OUT.mkdir(parents=True, exist_ok=True)
    BUCKETS.mkdir(parents=True, exist_ok=True)
    recs = load_manifest()
    done = {r["path"] for r in recs if "error" not in r}
    sel = select(prefixes)
    base = next_id(recs)
    todo = [(base + i, p, s) for i, (p, s) in enumerate(x for x in sel if x[0] not in done)]
    print(f"{len(sel):,} selected · {len(todo):,} to fingerprint · {len(done):,} already done")
    if not todo:
        return

    handles = {b: open(BUCKETS / f"{b:02d}.bin", "ab") for b in range(N_BUCKETS)}
    mf = open(MANIFEST, "a", encoding="utf-8")
    t0, n_hash, fails, read_bytes = time.time(), 0, 0, 0
    try:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for n, (rec, h, t) in enumerate(ex.map(fingerprint_one, todo, chunksize=2), 1):
                read_bytes += HEAD_BYTES + (SLICE_SEC * rec.get("rate", 44100)
                                             * rec.get("ch", 2) * rec.get("bits", 16) // 8)
                if h is None:
                    fails += 1
                else:
                    rows = np.empty(h.size, dtype=ROW)
                    rows["hash"], rows["track"], rows["time"] = h, np.uint32(rec["id"]), t
                    bk = (h >> BUCKET_SHIFT).astype(np.uint8)
                    for bi in np.unique(bk):
                        rows[bk == bi].tofile(handles[int(bi)])
                    n_hash += h.size
                mf.write(json.dumps(rec) + "\n")
                if n % 25 == 0 or n == len(todo):
                    mf.flush()
                    el = time.time() - t0
                    rate = n / el
                    print(f"  {n:,}/{len(todo):,} · {n_hash/1e6:.1f}M hashes · "
                          f"{read_bytes/1e6/el:.1f} MB/s · {rate*60:.0f}/min · "
                          f"~{(len(todo)-n)/max(rate,1e-6)/60:.0f} min left · {fails} failed")
    finally:
        for fh in handles.values():
            fh.close()
        mf.close()
    print(f"\ndone: {len(todo)-fails:,} fingerprinted, {fails} failed, "
          f"{n_hash/1e6:.1f}M hashes, {read_bytes/1e9:.1f} GB read in {(time.time()-t0)/60:.0f} min")


def cmd_dups(min_copies=2):
    """Byte-identical copies: same size AND same 256 KB head hash."""
    recs = [r for r in load_manifest() if r.get("head_sha")]
    groups = defaultdict(list)
    for r in recs:
        groups[(r["size"], r["head_sha"])].append(r["path"])
    dups = {k: v for k, v in groups.items() if len(v) >= min_copies}
    redundant = sum((len(v) - 1) * k[0] for k, v in dups.items())
    out = OUT / "exact-duplicates.json"
    out.write_text(json.dumps(
        [{"size": k[0], "head_sha": k[1], "copies": sorted(v)} for k, v in
         sorted(dups.items(), key=lambda kv: -len(kv[1]) * kv[0][0])], indent=1), encoding="utf-8")
    print(f"{len(recs):,} fingerprinted files · {len(dups):,} duplicate groups · "
          f"{sum(len(v) for v in dups.values()):,} files · {redundant/1e12:.2f} TB redundant")
    print(f"→ {out}")


def cmd_near(min_score=20):
    """Same recording in different files: fingerprints that line up at one
    time offset. Loads the run's buckets, sorts by hash, and queries every
    track against everything else. `min_score` = aligned landmark votes."""
    recs = {r["id"]: r for r in load_manifest() if r.get("n_hashes")}
    parts = [np.fromfile(BUCKETS / f"{b:02d}.bin", dtype=ROW)
             for b in range(N_BUCKETS) if (BUCKETS / f"{b:02d}.bin").exists()]
    rows = np.concatenate([p for p in parts if p.size]) if parts else np.empty(0, ROW)
    if not rows.size:
        print("no fingerprints yet")
        return
    rows.sort(order="hash")
    H, T, P = rows["hash"], rows["track"], rows["time"].astype(np.int32)
    print(f"{rows.size/1e6:.1f}M landmarks across {len(recs):,} tracks — matching…")

    # per track: its own landmarks, in track order, so each query is a slice
    order = np.argsort(T, kind="stable")
    Tq, Hq, Pq = T[order], H[order], P[order]
    bounds = np.searchsorted(Tq, np.arange(len(recs) + 1))
    pairs = {}
    for tid in range(len(recs)):
        a, b = bounds[tid], bounds[tid + 1]
        if b <= a:
            continue
        qh, qt = Hq[a:b], Pq[a:b]
        lo, hi = np.searchsorted(H, qh, "left"), np.searchsorted(H, qh, "right")
        votes = defaultdict(int)
        for i in range(qh.size):
            for j in range(lo[i], hi[i]):
                other = int(T[j])
                if other == tid:
                    continue
                votes[(other, int(P[j]) - int(qt[i]))] += 1
        best = defaultdict(int)
        for (other, off), v in votes.items():
            if v > best[other]:
                best[other] = v
        for other, v in best.items():
            if v >= min_score and tid < other:
                pairs[(tid, other)] = v
    out = OUT / "near-duplicates.json"
    res = [{"score": v, "a": recs[i]["path"], "b": recs[j]["path"],
            "same_bytes": recs[i].get("head_sha") == recs[j].get("head_sha") and recs[i]["size"] == recs[j]["size"]}
           for (i, j), v in sorted(pairs.items(), key=lambda kv: -kv[1])]
    out.write_text(json.dumps(res, indent=1), encoding="utf-8")
    exact = sum(1 for r in res if r["same_bytes"])
    print(f"{len(res):,} matching pairs (≥{min_score} aligned landmarks) · "
          f"{exact:,} are byte-identical · {len(res)-exact:,} are the same recording in different bytes")
    print(f"→ {out}")


def cmd_stats():
    recs = load_manifest()
    ok = [r for r in recs if r.get("n_hashes")]
    err = [r for r in recs if "error" in r]
    size = sum(f.stat().st_size for f in BUCKETS.glob("*.bin")) if BUCKETS.exists() else 0
    print(f"{len(ok):,} fingerprinted · {len(err):,} failed · "
          f"{sum(r['n_hashes'] for r in ok)/1e6:.1f}M landmarks · index {size/1e9:.2f} GB")
    if err:
        kinds = defaultdict(int)
        for r in err:
            kinds[r["error"].split(":")[0]] += 1
        print("failures:", dict(kinds))


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "dry", "run", "dups", "near", "stats"])
    ap.add_argument("--prefix", action="append", default=[], help="Vision path prefix, e.g. '/gallo-digital-cupboard/CMS Exports/'")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--min", type=int, default=20, help="near: minimum aligned landmarks")
    a = ap.parse_args()
    if a.cmd == "list":
        folder_menu()
    elif a.cmd in ("dry", "run") and not a.prefix:
        sys.exit("give at least one --prefix (see `list`)")
    elif a.cmd == "dry":
        cmd_dry(a.prefix)
    elif a.cmd == "run":
        cmd_run(a.prefix, a.workers)
    elif a.cmd == "dups":
        cmd_dups()
    elif a.cmd == "near":
        cmd_near(a.min)
    else:
        cmd_stats()
