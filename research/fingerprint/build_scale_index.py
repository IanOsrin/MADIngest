"""research/fingerprint/build_scale_index.py — fingerprint the catalogue at scale.

Same fingerprints as fp_landmark.py, different STORE. A dictionary was fine for
178 tracks; 10,000 tracks make ~460 million hashes, which no 16 GB machine will
hold as Python objects. So the index becomes three flat arrays — hash, track,
time — sorted by hash and searched with binary search.

Sorting 460M rows at once would also blow the RAM, so rows are written into 64
buckets by the top bits of the hash. Each bucket is sorted on its own (~700 MB),
and because the buckets are already in hash order, stitching them end to end
gives one globally sorted file. It is resumable for the same reason: a bucket
that is already written is skipped.

Audio is never kept. Each track is fetched, decoded, fingerprinted and deleted,
so the disk holds a handful of files at a time however long the run is.

    python3 build_scale_index.py fetch   # phase 1: fingerprint into buckets
    python3 build_scale_index.py merge   # phase 2: sort buckets, stitch index
    python3 build_scale_index.py stats
"""
import json, os, sys, time, subprocess, tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fp_landmark import peaks, spectrogram, hashes, HOP, SR  # noqa: E402

LAB = Path(os.environ.get("FP_LAB", "/Volumes/Bandlab/fingerprint-lab"))
SCALE = LAB / "scale"
BUCKETS = SCALE / "buckets"
MEDIA = os.environ.get("FP_MEDIA", "https://media.musicafricadirect.com/mp3")
N_BUCKETS = 64
BUCKET_SHIFT = 22 - 6          # hashes use 22 bits; top 6 choose the bucket
ROW = np.dtype([("hash", np.uint32), ("track", np.uint32), ("time", np.uint16)])


def bucket_of(h):
    return (h >> BUCKET_SHIFT).astype(np.uint8)


def fetch_and_fingerprint(args):
    """One track: fetch → fingerprint → delete. Returns arrays, never audio."""
    idx, filename = args
    tmp = Path(tempfile.gettempdir()) / f"fp-{os.getpid()}-{idx}.mp3"
    try:
        r = subprocess.run(["curl", "-sSL", "--max-time", "180", "-o", str(tmp),
                            f"{MEDIA}/{filename}.mp3"], capture_output=True)
        if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 50_000:
            return idx, filename, None, None, "download"
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(tmp), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
            capture_output=True, timeout=300).stdout
        x = np.frombuffer(out, dtype=np.float32)
        if x.size < SR * 5:
            return idx, filename, None, None, "too short"
        h, t = hashes(peaks(spectrogram(x)))
        return idx, filename, h.astype(np.uint32), t.astype(np.uint16), None
    except Exception as e:
        return idx, filename, None, None, str(e)[:60]
    finally:
        tmp.unlink(missing_ok=True)


def choose_tracks(target=10_000):
    """The 10,000: every track already in the small index, none of the held-back
    negatives, the rest a random spread. Keeping the 178 means the existing
    2,572 queries still have a right answer to find."""
    picked = SCALE / "tracks.json"
    if picked.exists():
        return json.loads(picked.read_text())
    corpus = json.loads((LAB / "corpus.json").read_text())
    keep = [r["filename"] for r in corpus[:-20]]
    held = set(r["filename"] for r in corpus[-20:])

    # The mirror lives behind GalloIngest's node helper; ask it through a tiny
    # script rather than adding a python pg dependency for one query. It writes
    # to a FILE: node's console.log to a pipe truncates at 64 KB when the script
    # calls process.exit() before the stream flushes.
    SCALE.mkdir(parents=True, exist_ok=True)
    pool_path = SCALE / "pool.json"
    subprocess.run(["node", "--input-type=module", "-e", f"""
      import dotenv from '/Users/ianosrin/Desktop/GalloIngestV1.2/node_modules/dotenv/lib/main.js';
      import {{ writeFileSync }} from 'node:fs';
      dotenv.config({{ path: '/Users/ianosrin/Desktop/GalloIngestV1.2/.env', quiet: true }});
      const {{ mirrorQuery }} = await import('/Users/ianosrin/Desktop/GalloIngestV1.2/lib/mirror-db.js');
      const {{ rows }} = await mirrorQuery(`
        SELECT DISTINCT ON (raw->>'Filename') raw->>'Filename' AS f
          FROM tracks WHERE COALESCE(raw->>'S3_URL','') <> '' AND COALESCE(raw->>'Filename','') <> ''
         ORDER BY raw->>'Filename', random() LIMIT {target * 2}`);
      writeFileSync('{pool_path}', JSON.stringify(rows.map(r => r.f)));
      process.exit(0);
    """], capture_output=True, text=True, cwd="/Users/ianosrin/Desktop/GalloIngestV1.2", timeout=300)
    pool = json.loads(pool_path.read_text())
    names = list(dict.fromkeys(keep + [f for f in pool if f not in held]))[:target]
    SCALE.mkdir(parents=True, exist_ok=True)
    picked.write_text(json.dumps(names))
    print(f"chose {len(names)} tracks ({len(keep)} carried over from the small index)")
    return names


def phase_fetch():
    names = choose_tracks()
    BUCKETS.mkdir(parents=True, exist_ok=True)
    done_path = SCALE / "done.json"
    done = set(json.loads(done_path.read_text())) if done_path.exists() else set()
    todo = [(i, n) for i, n in enumerate(names) if n not in done]
    print(f"{len(todo)} to fingerprint, {len(done)} already done")

    handles = {b: open(BUCKETS / f"{b:02d}.bin", "ab") for b in range(N_BUCKETS)}
    t0, hashes_total, failures = time.time(), 0, []
    try:
        with ProcessPoolExecutor(max_workers=6) as ex:
            for n, (idx, filename, h, t, err) in enumerate(
                    ex.map(fetch_and_fingerprint, todo, chunksize=1), 1):
                if err:
                    failures.append((filename, err))
                else:
                    rows = np.empty(h.size, dtype=ROW)
                    rows["hash"], rows["track"], rows["time"] = h, np.uint32(idx), t
                    b = bucket_of(h)
                    for bi in np.unique(b):
                        rows[b == bi].tofile(handles[int(bi)])
                    hashes_total += h.size
                done.add(filename)
                if n % 100 == 0:
                    rate = n / (time.time() - t0)
                    left = (len(todo) - n) / max(rate, 1e-6) / 60
                    print(f"  {n}/{len(todo)} · {hashes_total/1e6:.0f}M hashes · "
                          f"{rate*60:.0f}/min · ~{left:.0f} min left · {len(failures)} failed")
                    done_path.write_text(json.dumps(sorted(done)))
    finally:
        for fh in handles.values():
            fh.close()
        done_path.write_text(json.dumps(sorted(done)))
    (SCALE / "failures.json").write_text(json.dumps(failures))
    size = sum(f.stat().st_size for f in BUCKETS.glob("*.bin"))
    print(f"\n{hashes_total/1e6:.0f}M hashes · buckets {size/1e9:.1f} GB · {len(failures)} failed")


def phase_merge():
    """Sort each bucket, then stitch: buckets are already in hash order."""
    names = choose_tracks()
    out_h = open(SCALE / "hash.u32", "wb")
    out_t = open(SCALE / "track.u32", "wb")
    out_p = open(SCALE / "time.u16", "wb")
    total = 0
    for b in range(N_BUCKETS):
        path = BUCKETS / f"{b:02d}.bin"
        if not path.exists() or path.stat().st_size == 0:
            continue
        rows = np.fromfile(path, dtype=ROW)
        rows.sort(order="hash")                     # in-place, one bucket at a time
        rows["hash"].tofile(out_h)
        rows["track"].tofile(out_t)
        rows["time"].tofile(out_p)
        total += rows.size
        print(f"  bucket {b:02d}: {rows.size/1e6:.1f}M rows")
        del rows
    for fh in (out_h, out_t, out_p):
        fh.close()
    (SCALE / "meta.json").write_text(json.dumps({"names": names, "rows": int(total)}))
    print(f"\nindex: {total/1e6:.0f}M rows · "
          f"{sum((SCALE / f).stat().st_size for f in ['hash.u32', 'track.u32', 'time.u16'])/1e9:.1f} GB")


def load_scale_index():
    meta = json.loads((SCALE / "meta.json").read_text())
    h = np.memmap(SCALE / "hash.u32", dtype=np.uint32, mode="r")
    t = np.memmap(SCALE / "track.u32", dtype=np.uint32, mode="r")
    p = np.memmap(SCALE / "time.u16", dtype=np.uint16, mode="r")
    return meta["names"], h, t, p


def stats():
    if not (SCALE / "meta.json").exists():
        print("no index yet")
        return
    names, h, t, p = load_scale_index()
    print(f"{len(names)} tracks · {h.size/1e6:.0f}M hashes · "
          f"{h.nbytes/1e9 + t.nbytes/1e9 + p.nbytes/1e9:.1f} GB")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    {"fetch": phase_fetch, "merge": phase_merge, "stats": stats}.get(cmd, stats)()
