"""scripts/isrc-conflicts-xlsx.py — the songs whose ISRC differs between MadStreamer, MAM and the metadata cache,
with the evidence for each candidate (Ian, 2026-10-13: "Same song, different ISRCs … reveal in a spreadsheet").

For each candidate ISRC it shows which sources hold it, what song the cache (Ingrooves extract + register) has it
registered to, and whether another song on the same catalogue already carries it in MadStreamer or MAM. A
suggestion is made only when the evidence points one way. Read-only.

   python3 scripts/isrc-conflicts-xlsx.py tmp/isrc-gap-compare.json tmp/metadata-extract.json tmp/isrc-gap-mam.json out.xlsx
"""
import json, sys, re, unicodedata, collections
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

cmp_, cache_f, mam_f, out = sys.argv[1:5]
def V(v):
    s = re.sub(r'[\s-]', '', str(v or '')).upper()
    return s if re.fullmatch(r'[A-Z]{2}[A-Z0-9]{3}\d{7}', s) else ''
cat = lambda c: re.sub(r'[^A-Za-z0-9]', '', str(c or '')).upper()
def tn(s):   # loose: ignores case, accents, punctuation, bracketed bits
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', re.sub(r'\(.*?\)|\[.*?\]', ' ', s)).strip()
def strict(s): return re.sub(r'[^a-z0-9]+', '', unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower())
def title_match(a, b): return strict(a) == strict(b) or (tn(a) and tn(a) == tn(b))

rows = [r for r in json.load(open(cmp_))['rows'] if r['cat'] or r['title']]
cache = json.load(open(cache_f)); cache = cache if isinstance(cache, list) else cache['rows']
mam = json.load(open(mam_f))

reg = collections.defaultdict(list)                         # ISRC → cache rows
for c in cache:
    if V(c.get('isrc')): reg[V(c['isrc'])].append(c)
ms_by = collections.defaultdict(list)                       # ISRC → MadStreamer songs
for r in rows:
    if r['where'] == 'MadStreamer' and r['ms']: ms_by[r['ms']].append(r)
mam_by = collections.defaultdict(list)                      # ISRC → MAM songs
for m in mam:
    if V(m['isrcRaw']): mam_by[V(m['isrcRaw'])].append(m)

# today's fills (2026-10-13) came after the scan — add them so "used by another song here" sees them
import os
for p, kind in (('~/Downloads/madstreamer-isrc-fill/apply-log.jsonl', 'ms'), ('~/Downloads/mam-isrc-fill/apply-log.jsonl', 'mam')):
    p = os.path.expanduser(p); recs = os.path.join(os.path.dirname(p), 'records.json')
    if not os.path.exists(p): continue
    done = {json.loads(l)['recordId'] for l in open(p) if l.strip() and json.loads(l).get('ok') and json.loads(l).get('after')}
    for f in json.load(open(recs)):
        rid = str(f.get('fm_record_id') or f.get('recordId'))
        if rid not in done: continue
        if kind == 'ms': ms_by[f['isrc']].append({'msId': rid, 'cat': f['cat'], 'title': f['title']})
        else: mam_by[f['isrc']].append({'id': rid, 'cat': f['cat'], 'title': f['title']})

SRC = (('ms', 'MadStreamer'), ('mam', 'MAM'), ('cache', 'Cache'))
conf = [r for r in rows if len({r[k] for k, _ in SRC if r[k]}) > 1]

def evidence(r, v):
    """facts about candidate ISRC v for song r"""
    regs = reg.get(v, [])
    reg_here = [c for c in regs if cat(c['catalogue']) == cat(r['cat'])]
    reg_title = (reg_here or regs or [{}])[0].get('track_name')
    reg_ok = any(title_match(c['track_name'], r['title']) for c in regs)
    other_ms = [h for h in ms_by.get(v, []) if cat(h['cat']) == cat(r['cat']) and str(h['msId']) != str(r['msId']) and not title_match(h['title'], r['title'])]
    other_mam = [h for h in mam_by.get(v, []) if cat(h['cat']) == cat(r['cat']) and str(h['id']) != str(r['mamId']) and not title_match(h['title'], r['title'])]
    other = list(dict.fromkeys([f"{h['title']} (MadStreamer)" for h in other_ms] + [f"{h['title']} (MAM)" for h in other_mam]))
    other = '; '.join(other[:4]) + (f'; … +{len(other) - 4} more' if len(other) > 4 else '')
    return dict(isrc=v, held=[n for k, n in SRC if r[k] == v], reg_title=reg_title, reg_cat=(reg_here or regs or [{}])[0].get('catalogue'),
                reg_ok=reg_ok, registered=bool(regs), other=other)

out_rows = []
for r in conf:
    cands = list(dict.fromkeys(r[k] for k, _ in SRC if r[k]))
    ev = [evidence(r, v) for v in cands]
    good = [e for e in ev if e['reg_ok'] and not e['other']]
    bad = [e for e in ev if (e['registered'] and not e['reg_ok']) or e['other']]
    if len(good) == 1 and len(bad) == len(ev) - 1:
        sug, why = good[0]['isrc'], 'register has it for this song; the other is registered to / used by another song'
    elif len(good) == 1:
        sug, why = good[0]['isrc'], 'only one is registered to this song title'
    elif len(good) > 1:
        sug, why = '', 'both are registered to this title (re-recording or double registration?) — check'
    elif any(e['other'] for e in ev) and len([e for e in ev if not e['other']]) == 1:
        e = [e for e in ev if not e['other']][0]; sug, why = e['isrc'], 'the other is already used by another song on this album'
    else:
        sug, why = '', 'no clear evidence — check the label copy'
    # pattern: whole album shifted (the wrong value belongs to a neighbour on the same album)
    shift = any(e['other'] for e in ev)
    wrong = [n for e in ev if e['isrc'] != sug for n in e['held']] if sug else []
    out_rows.append(dict(r=r, ev=ev, sug=sug, why=why, fix=', '.join(wrong), shift=shift))

wb = Workbook()
H = PatternFill('solid', fgColor='6D28D9'); GOOD = PatternFill('solid', fgColor='DCFCE7'); BAD = PatternFill('solid', fgColor='FEE2E2')
def head(ws, cols, widths):
    ws.append(cols)
    for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = H; c.alignment = Alignment(wrap_text=True, vertical='top')
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'D2'

s = wb.active; s.title = 'Summary'
alb = collections.Counter(cat(o['r']['cat']) for o in out_rows)
by_fix = collections.Counter(o['fix'] for o in out_rows if o['sug'])
lines = [
    ['Same song, different ISRCs — MadStreamer vs MAM vs metadata cache (13 Oct 2026)'],
    [],
    ['Songs with a conflict', len(out_rows)],
    ['  …on albums', len(alb)],
    ['  …on the website now (has ISRC + barcode, not hidden in MadStreamer)', sum(1 for o in out_rows if o['r']['onSite'] and o['r']['ms'])],
    [],
    ['A suggestion is made (evidence points one way)', sum(1 for o in out_rows if o['sug'])],
    ['  …the suggestion means changing MadStreamer', sum(1 for o in out_rows if 'MadStreamer' in o['fix'])],
    ['  …the suggestion means changing MAM', sum(1 for o in out_rows if 'MAM' in o['fix'])],
    ['  …the suggestion means the cache is the odd one out', sum(1 for o in out_rows if o['fix'] == 'Cache')],
    ['No suggestion — needs the label copy / register', sum(1 for o in out_rows if not o['sug'])],
    [],
    ['Wrong value belongs to another song on the same album (album shifted / swapped)', sum(1 for o in out_rows if o['shift'])],
    [],
    ['Albums where ONE ISRC sits on 3+ different songs (pasted down the album) — see that sheet', 'SEE_MANY'],
    [],
    ['Which pair disagrees'],
]
for row in lines: s.append(row)
pairs = collections.Counter(' vs '.join(sorted({n for e in o['ev'] for n in e['held']})) + f" ({len(o['ev'])} values)" for o in out_rows)
for k, v in pairs.most_common(): s.append(['  ' + k, v])
s.append([]); s.append(['Albums with the most conflicts'])
for k, v in alb.most_common(15):
    o = next(o for o in out_rows if cat(o['r']['cat']) == k); s.append([f"  {o['r']['cat']} — {o['r']['album'] or ''}", v])
s['A1'].font = Font(bold=True, size=13); s.column_dimensions['A'].width = 80; s.column_dimensions['B'].width = 10

ws = wb.create_sheet('All conflicts')
cols = ['Catalogue', 'Album', 'Song', 'Artist', '#', 'Filename', 'MadStreamer record', 'MAM record', 'On website?',
        'MadStreamer ISRC', 'MAM ISRC', 'Cache ISRC',
        'Suggested ISRC', 'Change in', 'Why',
        'ISRC A', 'A held by', 'A registered to (cache)', 'A also used by another song here',
        'ISRC B', 'B held by', 'B registered to (cache)', 'B also used by another song here',
        'ISRC C', 'C held by', 'C registered to (cache)', 'Checked ✓']
head(ws, cols, [13, 26, 28, 20, 4, 13, 11, 10, 8, 15, 15, 15, 15, 14, 40, 15, 16, 30, 30, 15, 16, 30, 30, 15, 12, 26, 9])
show = lambda r, k: r[k] if r[k] else ('—' if (k == 'ms' and r['msId']) or (k == 'mam' and r['mamId']) or k == 'cache' and r[k] == '' else 'n/a')
for o in sorted(out_rows, key=lambda o: (not o['sug'], o['r']['cat'] or '', str(o['r']['seq']))):
    r = o['r']; ev = o['ev'] + [None] * (3 - len(o['ev']))
    line = [r['cat'], r['album'], r['title'], r['artist'], r['seq'], r['file'], int(r['msId']) if r['msId'] else '', int(r['mamId']) if r['mamId'] else '',
            'yes' if r['onSite'] and r['ms'] else 'no', show(r, 'ms'), show(r, 'mam'), show(r, 'cache'), o['sug'], o['fix'], o['why']]
    for e in ev[:2]:
        line += [e['isrc'], ', '.join(e['held']), f"{e['reg_title']} ({e['reg_cat']})" if e['registered'] else 'not in the register', e['other']] if e else ['', '', '', '']
    e = ev[2]; line += [e['isrc'], ', '.join(e['held']), f"{e['reg_title']} ({e['reg_cat']})" if e['registered'] else 'not in the register'] if e else ['', '', '']
    line += ['']
    ws.append(line)
    i = ws.max_row
    if o['sug']:
        for col, k in ((10, 'ms'), (11, 'mam'), (12, 'cache')):
            if r[k]: ws.cell(i, col).fill = GOOD if r[k] == o['sug'] else BAD
ws.auto_filter.ref = ws.dimensions

# one ISRC pasted onto several DIFFERENT songs of one album
ws = wb.create_sheet('One ISRC on many songs')
head(ws, ['Database', 'Catalogue', 'ISRC', 'Different songs carrying it', 'Registered to (cache)', 'The songs'], [13, 15, 15, 12, 34, 110])
many = []
for db, idx, key in (('MadStreamer', ms_by, 'msId'), ('MAM', mam_by, 'id')):
    for v, hs in idx.items():
        byc = collections.defaultdict(dict)
        for h in hs: byc[cat(h['cat'])].setdefault(tn(h['title']) or strict(h['title']), h)
        for c, songs in byc.items():
            if len(songs) >= 3:
                regs = reg.get(v, []); rt = f"{regs[0]['track_name']} ({regs[0]['catalogue']})" if regs else 'not in the register'
                many.append((db, next(iter(songs.values()))['cat'], v, len(songs), rt, '; '.join(h['title'] for h in songs.values())))
for m in sorted(many, key=lambda m: -m[3]): ws.append(list(m))
ws.auto_filter.ref = ws.dimensions
s_many = len(many)

rd = wb.create_sheet('Read me')
for l in [
    'Every song where MadStreamer (the website\'s database, copy of ~03:00 today), MAM (read live today) and the metadata cache (Ingrooves extract + ISRC register) hold DIFFERENT valid ISRCs. Nothing was changed.',
    'Songs are paired MadStreamer ↔ MAM by catalogue + Filename, and with the cache by catalogue + song title. "n/a" = that source has no matching song; "—" = it has the song but no ISRC.',
    'For each candidate ISRC (A, B, C): which databases hold it; which song the cache has it registered to (looked up by the ISRC itself, anywhere in the cache); and whether another song on the SAME catalogue already carries it in MadStreamer or MAM — the sign of an album where ISRCs slid one track, or two songs swapped.',
    '"Suggested ISRC" is filled only when the evidence points one way: the register has it for this song title and the other value is registered to / used by a different song. Green = that database already holds the suggested value, red = it would change. "Change in" lists the databases holding the other value.',
    'Rows with a suggestion come first. Where there is no suggestion (both registered to this title, or neither), check the label copy / ISRC register.',
    '"One ISRC on many songs": an ISRC carried by 3 or more DIFFERENT songs (by title) on the same catalogue in one database — usually one value copied down a whole album. Every song there except (at most) one is wrong.',
    'Note: some songs were just filled today (690 in MadStreamer, 128 in MAM) — none of those are here, because a fill was only done where every source agreed.',
]: rd.append([l])
rd.column_dimensions['A'].width = 150
for c in rd['A']: c.alignment = Alignment(wrap_text=True, vertical='top')
for row in s.iter_rows():
    for c in row:
        if c.value == 'SEE_MANY': c.value = s_many
wb.save(out)
print(out, len(out_rows), 'suggested', sum(1 for o in out_rows if o['sug']), 'shift', sum(1 for o in out_rows if o['shift']))
print(collections.Counter(o['why'] for o in out_rows).most_common())
