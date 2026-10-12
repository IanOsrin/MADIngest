"""research/fingerprint/full_catalogue.py — every catalogue recording's landmark PEAKS, for the full index.

Ian, 2026-10-12: "start the full catalogue download with a progress report each 1000 done".

Stores PEAKS (not finished words), so any fingerprint design can be built from them later without
downloading the audio again (the 2026-10-12 design test rebuilt everything from stored data). Audio is
never kept: each track is fetched from the CDN, decoded, its peaks found, then deleted.

  python3 full_catalogue.py run          # resumable — run again after any stop and it carries on
  python3 full_catalogue.py status

Out, in $FP_LAB/full/:
  list.json        every distinct audio Filename in the mirror that has an S3 file
  peaks.dat        (u16 frame, u16 bin) per peak, recordings one after another
  tracks.jsonl     one line per recording done: {"file", "off", "n", "seconds", "src"}
  failures.jsonl   one line per recording that could not be fetched or decoded
  progress.log     a PROGRESS line every 1,000 recordings, DONE at the end
The 9,962 recordings of the 10k run are seeded from trip10k/peaks.* (rebuilt from that index — the
triplet words they give are the same as from the original peaks), so only the rest is downloaded.
"""
import json, os, subprocess, sys, tempfile, time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fp_landmark import peaks, spectrogram, SR  # noqa: E402

LAB = Path(os.environ.get("FP_LAB", "/Volumes/Bandlab/fingerprint-lab"))
OUT = LAB / "full"
SEED = LAB / "trip10k"
MEDIA = os.environ.get("FP_MEDIA", "https://media.musicafricadirect.com/mp3")
WORKERS = int(os.environ.get("FP_WORKERS", 8))
REPORT_EVERY = 1000
GI = Path(__file__).resolve().parents[2]          # GalloIngestV1.2


def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with open(OUT / "progress.log", "a") as f:
        f.write(line + "\n")


def catalogue_list():
    p = OUT / "list.json"
    if p.exists():
        return json.loads(p.read_text())
    # the mirror lives behind GalloIngest's node helper (same as build_scale_index.choose_tracks);
    # it writes to a FILE — node's console.log to a pipe truncates at 64 KB on process.exit()
    subprocess.run(["node", "--input-type=module", "-e", f"""
      import dotenv from '{GI}/node_modules/dotenv/lib/main.js';
      import {{ writeFileSync }} from 'node:fs';
      dotenv.config({{ path: '{GI}/.env', quiet: true }});
      const {{ mirrorQuery }} = await import('{GI}/lib/mirror-db.js');
      const {{ rows }} = await mirrorQuery(`
        SELECT DISTINCT raw->>'Filename' AS f FROM tracks
         WHERE COALESCE(raw->>'S3_URL','') <> '' AND COALESCE(raw->>'Filename','') <> '' ORDER BY 1`);
      writeFileSync('{p}', JSON.stringify(rows.map(r => r.f)));
      process.exit(0);
    """], capture_output=True, text=True, cwd=str(GI), timeout=600, check=True)
    return json.loads(p.read_text())


def done_files():
    done, end = set(), 0
    p = OUT / "tracks.jsonl"
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip():
                r = json.loads(line); done.add(r["file"]); end = max(end, (r["off"] + r["n"]) * 4)
    f = OUT / "failures.jsonl"
    failed = {json.loads(l)["file"] for l in f.read_text().splitlines() if l.strip()} if f.exists() else set()
    return done, failed, end


def write_track(fh, file, pk, seconds, src):
    pk = pk[(pk[:, 0] >= 0) & (pk[:, 0] < 65536)]              # frame is stored in 16 bits (~25 min)
    off = fh.tell() // 4
    fh.write(np.ascontiguousarray(pk, "<u2").tobytes())
    fh.flush()
    with open(OUT / "tracks.jsonl", "a") as t:
        t.write(json.dumps({"file": file, "off": off, "n": int(len(pk)), "seconds": round(seconds, 2), "src": src}) + "\n")


def seed_from_10k(fh, done):
    names = json.loads((SEED / "names.json").read_text())
    idx = np.fromfile(SEED / "peaks.idx", dtype="<u8")
    dat = np.memmap(SEED / "peaks.dat", dtype="<u2", mode="r").reshape(-1, 2)
    n = 0
    for i, name in enumerate(names):
        a, b = int(idx[i]), int(idx[i + 1])
        if name in done or b == a:
            continue                                         # (the 38 that never downloaded have no peaks)
        pk = np.asarray(dat[a:b], dtype=np.int32)
        write_track(fh, name, pk, (int(pk[-1, 0]) + 1) * 256 / SR, "index10k")
        done.add(name); n += 1
    return n


def fetch(filename):
    """One recording: fetch → decode → peaks → delete. Returns peaks, never audio."""
    tmp = Path(tempfile.gettempdir()) / f"fpfull-{os.getpid()}.mp3"
    try:
        r = subprocess.run(["curl", "-sSL", "--max-time", "180", "-o", str(tmp), f"{MEDIA}/{filename}.mp3"], capture_output=True)
        if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 20_000:
            return filename, None, 0, "download"
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(tmp), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                             capture_output=True, timeout=300).stdout
        x = np.frombuffer(out, dtype=np.float32)
        if x.size < SR * 3:
            return filename, None, 0, "too short / undecodable"
        return filename, peaks(spectrogram(x)), x.size / SR, None
    except Exception as e:
        return filename, None, 0, str(e)[:80]
    finally:
        try: tmp.unlink()
        except OSError: pass


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    names = catalogue_list()
    done, failed, end = done_files()
    with open(OUT / "peaks.dat", "ab") as fh:
        fh.truncate(end)                                     # drop a half-written recording from a crash
        fh.seek(end)
        seeded = seed_from_10k(fh, done) if SEED.exists() else 0
        todo = [n for n in names if n not in done and n not in failed]
        log(f"START {len(names):,} recordings in the catalogue · {len(done):,} already have peaks"
            f"{f' ({seeded:,} seeded from the 10k index)' if seeded else ''} · {len(failed):,} failed before · {len(todo):,} to download · {WORKERS} at a time")
        t0, n_ok, n_fail = time.time(), 0, 0
        with ProcessPoolExecutor(max_workers=WORKERS) as ex:
            for i, (file, pk, seconds, err) in enumerate(ex.map(fetch, todo, chunksize=1), 1):
                if err:
                    n_fail += 1
                    with open(OUT / "failures.jsonl", "a") as f:
                        f.write(json.dumps({"file": file, "error": err}) + "\n")
                else:
                    write_track(fh, file, pk, seconds, "cdn"); n_ok += 1
                if i % REPORT_EVERY == 0 or i == len(todo):
                    rate = i / max(1e-6, time.time() - t0) * 60
                    left = (len(todo) - i) / max(rate, 1e-6)
                    size = fh.tell() / 1e9
                    log(f"PROGRESS {i:,} / {len(todo):,} downloaded ({i / len(todo):.0%}) · {rate:.0f}/min · "
                        f"about {left / 60:.1f} h left · {n_fail:,} failed · peaks file {size:.2f} GB")
    log(f"DONE {n_ok:,} new recordings fingerprinted, {n_fail:,} failed, in {(time.time() - t0) / 3600:.1f} h")


def status():
    names = json.loads((OUT / "list.json").read_text()) if (OUT / "list.json").exists() else []
    done, failed, end = done_files()
    print(f"{len(done):,} of {len(names):,} recordings have peaks · {len(failed):,} failed · peaks file {end / 1e9:.2f} GB")


if __name__ == "__main__":
    {"run": run, "status": status}.get(sys.argv[1] if len(sys.argv) > 1 else "status", status)()
