"""Prepare the Rust matcher test from the fingerprint lab (read-only on the lab's own files).

  1. index  → rust/index.rows (hash u32, track u32, time u16; sorted by hash, postings kept in
              the Python index's order) + rust/names.json — the 10k run's on-disk layout
  2. peaks  → rust/peaks.bin: for every query in queries.json, its landmark peaks (n, then n×(t,f) int32)
  3. python → rust/python-results.json: the Python pitch-sweep matcher's answer for every query,
              plus how long the MATCHING took (peaks are found once, outside the timing)
Run from anywhere:  python3 prepare.py
"""
import json, os, pickle, struct, sys, time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np
sys.path.insert(0, os.path.expanduser('~/Desktop/GalloIngestV1.2/research/fingerprint'))
import fp_landmark as L

LAB = L.LAB
OUT = LAB / 'rust'
FAT = LAB / 'landmark-index-fat.pkl'      # the dense index (28 peaks/s, fanout 8) behind the 97.4%
ROW = np.dtype([('hash', '<u4'), ('track', '<u4'), ('time', '<u2')])
_W = {}

def init():
    d = pickle.loads(FAT.read_bytes()); _W['names'], _W['table'] = d['names'], d['table']

def job(args):
    qfile, path = args
    try:
        pk = L.peaks_for_file(path)
    except Exception:
        return qfile, np.zeros((0, 2), np.int32), ('', 0, 0.0, 0.0), 0.0, 0.0
    s = time.perf_counter()
    best, best_semi = ('', 0, 0.0, 0.0), 0.0
    for semi in L.SWEEP:
        h, t = L.hashes_scaled(pk, 2.0 ** (-semi / 12.0))
        res = L.match(h, t, _W['names'], _W['table'], top=1)
        if res and res[0][1] > best[1]:
            best, best_semi = res[0], semi
    return qfile, pk, best, best_semi, time.perf_counter() - s

if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    print('exporting the index…', flush=True)
    d = pickle.loads(FAT.read_bytes()); names, table = d['names'], d['table']
    keys = np.array(sorted(table.keys()), np.int64)
    print(f'  widest hash: {int(keys.max()).bit_length()} bits')
    n = sum(len(table[k]) for k in keys.tolist())
    rows = np.empty(n, ROW); p = 0
    for k in keys.tolist():
        post = table[k]; m = len(post)
        rows['hash'][p:p + m] = k; rows['track'][p:p + m] = post[:, 0]; rows['time'][p:p + m] = post[:, 1]; p += m
    assert rows['time'].max() < 65536
    rows.tofile(OUT / 'index.rows'); (OUT / 'names.json').write_text(json.dumps(names))
    print(f'  {len(names)} tracks · {n:,} rows · {len(keys):,} distinct hashes', flush=True)
    del d, table

    queries = [q for q in json.loads((LAB / 'queries.json').read_text()) if (L.QUERIES / q['file']).exists()]
    jobs = [(q['file'], str(L.QUERIES / q['file'])) for q in queries]
    print(f'peaks + Python matcher on {len(jobs)} queries…', flush=True)
    res, match_s = {}, 0.0
    with open(OUT / 'peaks.bin', 'wb') as pf, ProcessPoolExecutor(4, initializer=init) as ex:
        for i, (qfile, pk, best, semi, secs) in enumerate(ex.map(job, jobs, chunksize=8), 1):
            pf.write(struct.pack('<I', len(pk))); pf.write(np.ascontiguousarray(pk, '<i4').tobytes())
            res[qfile] = {'match': best[0], 'votes': best[1], 'offset_frames': round(best[2] * L.SR / L.HOP), 'semitones': semi}
            match_s += secs
            if i % 500 == 0: print(f'  {i}/{len(jobs)}', flush=True)
    (OUT / 'queries.json').write_text(json.dumps([j[0] for j in jobs]))
    (OUT / 'python-results.json').write_text(json.dumps({'match_seconds_total': match_s, 'results': res}))
    print(f'Python matching: {match_s:.1f} s of CPU over {len(jobs)} queries ({match_s / len(jobs) * 1000:.0f} ms each)')
