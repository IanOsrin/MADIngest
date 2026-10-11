"""Rust vs Python matcher: same answer for every query? Then the lab's scorecard from each."""
import json, sys
from pathlib import Path
LAB = Path('/Volumes/Bandlab/fingerprint-lab'); R = LAB / 'rust'
py, rs = json.loads((R / 'python-results.json').read_text()), json.loads((R / sys.argv[1] if len(sys.argv) > 1 else R / 'rust-results.json').read_text())
corpus = json.loads((LAB / 'corpus.json').read_text()); held = {r['filename'] for r in corpus[-20:]}
meta = {q['file']: q for q in json.loads((LAB / 'queries.json').read_text())}
diff = [(f, p, rs['results'].get(f)) for f, p in py['results'].items() if rs['results'].get(f) != p]
print(f"queries: {len(py['results'])} · identical: {len(py['results']) - len(diff)} · different: {len(diff)}")
for f, p, r in diff[:10]: print('  ', f, '\n     python', p, '\n     rust  ', r)
def card(res, name):
    pos = [(f, v) for f, v in res.items() if meta[f]['filename'] not in held]; neg = [(f, v) for f, v in res.items() if meta[f]['filename'] in held]
    for t in (12, 20):
        rec = sum(1 for f, v in pos if v['match'] == meta[f]['filename'] and v['votes'] >= t) / len(pos)
        fp = sum(1 for f, v in neg if v['votes'] >= t) / len(neg)
        print(f"  {name:<7} ≥{t} votes: recall {rec:.1%} · false positives {fp:.1%}")
card(py['results'], 'python'); card(rs['results'], 'rust')
print(f"matching time: python {py['match_seconds_total'] / len(py['results']) * 1000:.0f} ms/query · rust {rs['match_seconds_total'] / len(rs['results']) * 1000:.1f} ms/query "
      f"→ {py['match_seconds_total'] / rs['match_seconds_total']:.0f}× (rust wall {rs['wall_seconds']:.2f} s on {rs['threads']} threads)")
