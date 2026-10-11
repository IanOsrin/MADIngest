"""Scorecard for a fp_match results file: recall per attack + false positives on the held-back tracks."""
import json, sys
from pathlib import Path
LAB = Path('/Volumes/Bandlab/fingerprint-lab')
rs = json.loads(Path(sys.argv[1]).read_text())['results']
corpus = json.loads((LAB / 'corpus.json').read_text()); held = {r['filename'] for r in corpus[-20:]}
meta = {q['file']: q for q in json.loads((LAB / 'queries.json').read_text())}
pos = [(f, v) for f, v in rs.items() if meta[f]['filename'] not in held]; neg = [(f, v) for f, v in rs.items() if meta[f]['filename'] in held]
T = (12, 20, 30, 50)
print(f"{'attack':<12}" + ''.join(f"{'≥' + str(t):>7}" for t in T))
for atk in sorted({meta[f]['attack'] for f, _ in pos}):
    sub = [(f, v) for f, v in pos if meta[f]['attack'] == atk]
    print(f"{atk:<12}" + ''.join(f"{sum(1 for f, v in sub if v['match'] == meta[f]['filename'] and v['votes'] >= t) / len(sub):>7.0%}" for t in T))
for t in T:
    rec = sum(1 for f, v in pos if v['match'] == meta[f]['filename'] and v['votes'] >= t) / len(pos)
    fp = sum(1 for f, v in neg if v['votes'] >= t) / len(neg)
    print(f"  ≥{t:>2} votes: recall {rec:6.1%} · false positives {fp:6.1%}")
print(f"  strangers' best scores: max {max(v['votes'] for _, v in neg)}, top 5 {sorted((v['votes'] for _, v in neg), reverse=True)[:5]}")
