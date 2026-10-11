"""research/fingerprint/peaks_cli.py — one audio file → its landmark peaks, for the Check Audio tab.

    python3 peaks_cli.py <audio file> <out.bin> [max seconds]

Same decode / spectrogram / peaks as the index was built with (fp_landmark.py), so a query and the
index always agree. Writes the peaks the way fp_match reads them (u32 count, then count × (i32 frame,
i32 bin)) and prints {"seconds": …, "peaks": …} on stdout.
"""
import json, struct, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from fp_landmark import decode, spectrogram, peaks, SR  # noqa: E402

if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    max_s = float(sys.argv[3]) if len(sys.argv) > 3 else 1200.0
    x = decode(src)
    seconds = x.size / SR
    x = x[: int(max_s * SR)]                      # the matcher packs query time in 16 bits (~25 min)
    pk = peaks(spectrogram(x))
    with open(out, "wb") as f:
        f.write(struct.pack("<I", len(pk)))
        f.write(np.ascontiguousarray(pk, "<i4").tobytes())
    print(json.dumps({"seconds": round(seconds, 2), "scanned": round(min(seconds, max_s), 2), "peaks": int(len(pk))}))
