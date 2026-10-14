"""scripts/whole-album-duplicates-xlsx.py — albums held TWICE IN FULL (every song of the catalogue present 2+ times)
in MAM and in MadStreamer (Ian, 2026-10-14: "produce the list of duplicates" — "only whole albums, nothing else").
Read-only. Partial duplicates (a few songs twice) are deliberately left out.

Per album the copies are told apart by record id order per song; each copy is described (track numbers, filenames,
ISRCs, linked to MadStreamer) and the most complete copy is suggested to KEEP, the others to REMOVE.

   python3 scripts/whole-album-duplicates-xlsx.py tmp/isrc-gap-mam.json tmp/isrc-gap-compare.json tmp/isrc-allocation-tracks.json out.xlsx
"""
import json, sys, re, os, unicodedata, collections
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

mam_f, cmp_f, ms_f, out = sys.argv[1:5]
cat = lambda c: re.sub(r'[^A-Za-z0-9]', '', str(c or '')).upper()
nt = lambda s: re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower())
V = lambda v: (lambda s: s if re.fullmatch(r'[A-Z]{2}[A-Z0-9]{3}\d{7}', s) else '')(re.sub(r'[\s-]', '', str(v or '')).upper())

def overlay(*folders):
    v = {}
    for f in folders:
        p = os.path.expanduser(f'~/Downloads/{f}/apply-log.jsonl')
        if os.path.exists(p):
            for l in open(p):
                j = json.loads(l)
                if j.get('ok') and j.get('after'): v[j['recordId']] = j['after']
    return v
mam_isrc = overlay('mam-isrc-fill', 'mam-cache-isrc')
ms = json.load(open(ms_f))
album_of = {}                                              # MAM has no album title: take MadStreamer's, else the cache's
cache_p = os.path.join(os.path.dirname(os.path.abspath(ms_f)), 'metadata-extract.json')
if os.path.exists(cache_p):
    cc = json.load(open(cache_p)); cc = cc if isinstance(cc, list) else cc['rows']
    for c in cc:
        if c.get('catalogue') and c.get('album_title'): album_of.setdefault(cat(c['catalogue']), c['album_title'])
for t in ms:
    if t.get('album'): album_of[cat(t['cat'])] = t['album']
mam_alb_p = os.path.join(os.path.dirname(os.path.abspath(ms_f)), 'mam-album-titles.json')   # MAM Albums table, by catalogue
if os.path.exists(mam_alb_p):
    for c, a in json.load(open(mam_alb_p)).items():
        label = ' — '.join(x for x in (a.get('title'), a.get('artist')) if x)
        if label: album_of[cat(c)] = label
mam = [dict(id=str(m['id']), cat=m['cat'], title=m['title'], seq=m['seq'], file=m['file'], isrc=mam_isrc.get(str(m['id'])) or V(m['isrcRaw']),
            album=album_of.get(cat(m['cat']), '')) for m in json.load(open(mam_f))]
linked = {str(r['mamId']) for r in json.load(open(cmp_f))['rows'] if r['where'] == 'MadStreamer' and r['mamId']}
for m in mam: m['linked'] = m['id'] in linked
for t in ms: t['isrc'] = V(t['isrc'])

def whole(records):
    by = collections.defaultdict(list)
    for r in records: by[cat(r['cat'])].append(r)
    found = []
    for c, ss in by.items():
        g = collections.defaultdict(list)
        for s in ss:
            if nt(s['title']): g[nt(s['title'])].append(s)
        counts = {len(v) for v in g.values()}
        if len(g) < 2 or min(counts) < 2 or len(counts) != 1: continue
        k = counts.pop()
        copies = [[] for _ in range(k)]
        for v in g.values():
            for i, s in enumerate(sorted(v, key=lambda s: int(s['id']))): copies[i].append(s)
        found.append((ss[0]['cat'], len(g), copies))
    return found

def describe(copy, db):
    n = len(copy)
    d = dict(ids=sorted(int(s['id']) for s in copy), seq=sum(1 for s in copy if str(s.get('seq') or '').strip()),
             file=sum(1 for s in copy if str(s.get('file') or '').strip()), isrc=sum(1 for s in copy if s.get('isrc')),
             linked=sum(1 for s in copy if s.get('linked')) if db == 'MAM' else None,
             upc=sum(1 for s in copy if str(s.get('upc') or '').strip()) if db == 'MadStreamer' else None,
             album=next((s.get('album') for s in copy if s.get('album')), ''))
    d['score'] = (d['linked'] or 0) * 4 + (d['upc'] or 0) * 4 + d['isrc'] * 2 + d['file'] + d['seq']
    return d

wb = Workbook(); H = PatternFill('solid', fgColor='6D28D9')
KEEP = PatternFill('solid', fgColor='DCFCE7'); DROP = PatternFill('solid', fgColor='FEE2E2')
res = {'MAM': whole(mam), 'MadStreamer': whole(ms)}

s = wb.active; s.title = 'Summary'
s.append(['Albums held twice IN FULL — every song of the album present 2+ times (14 Oct 2026)']); s['A1'].font = Font(bold=True, size=13)
s.append([]); s.append(['', 'MAM', 'MadStreamer'])
s.append(['Albums', len(res['MAM']), len(res['MadStreamer'])])
s.append(['Songs per copy (total)', sum(n for _, n, _ in res['MAM']), sum(n for _, n, _ in res['MadStreamer'])])
s.append(['Extra records (would be removed)', sum(n * (len(c) - 1) for _, n, c in res['MAM']), sum(n * (len(c) - 1) for _, n, c in res['MadStreamer'])])
s.append([]); s.append(['Partial duplicates (only some songs twice) are not included.'])
s.column_dimensions['A'].width = 60; s.column_dimensions['B'].width = 12; s.column_dimensions['C'].width = 14

for db in ('MAM', 'MadStreamer'):
    a = wb.create_sheet(f'{db} albums')
    cols = ['Catalogue', 'Album', 'Songs', 'Copies', 'KEEP copy — record ids', 'its track #s / filenames / ISRCs', 'linked to MadStreamer' if db == 'MAM' else 'with barcode',
            'REMOVE copy — record ids', 'its track #s / filenames / ISRCs', 'linked to MadStreamer' if db == 'MAM' else 'with barcode', 'Done ✓']
    a.append(cols)
    for c in a[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = H; c.alignment = Alignment(wrap_text=True, vertical='top')
    for i, w in enumerate([15, 30, 7, 7, 26, 16, 11, 26, 16, 11, 8], 1): a.column_dimensions[get_column_letter(i)].width = w
    r_ = wb.create_sheet(f'{db} records')
    r_.append(['Catalogue', 'Song', 'Track #', 'Record', 'Filename', 'ISRC', 'Copy', 'Suggested', 'Done ✓'])
    for c in r_[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = H
    for i, w in enumerate([15, 34, 7, 10, 14, 15, 7, 11, 8], 1): r_.column_dimensions[get_column_letter(i)].width = w
    rng = lambda ids: f'{ids[0]}–{ids[-1]}' if ids[-1] - ids[0] == len(ids) - 1 else ', '.join(map(str, ids))
    for c_, n, copies in sorted(res[db], key=lambda x: cat(x[0])):
        ds = [describe(cp, db) for cp in copies]
        keep = max(range(len(ds)), key=lambda i: (ds[i]['score'], -ds[i]['ids'][0]))
        drops = [i for i in range(len(ds)) if i != keep]
        link = lambda d: d['linked'] if db == 'MAM' else d['upc']
        for j, di in enumerate(drops):
            k = ds[keep]; d = ds[di]
            a.append([c_, k['album'] or d['album'], n, len(copies), rng(k['ids']), f"{k['seq']} / {k['file']} / {k['isrc']}", link(k),
                      rng(d['ids']), f"{d['seq']} / {d['file']} / {d['isrc']}", link(d), ''])
            for col in (5, 6, 7): a.cell(a.max_row, col).fill = KEEP
            for col in (8, 9, 10): a.cell(a.max_row, col).fill = DROP
        for i, cp in enumerate(copies):
            for srec in sorted(cp, key=lambda s: (int(re.sub(r'\D', '', str(s.get('seq') or '')) or 999), s['title'] or '')):
                r_.append([c_, srec['title'], srec.get('seq') or '', int(srec['id']), srec.get('file') or '', srec.get('isrc') or '', chr(65 + i), 'keep' if i == keep else 'REMOVE', ''])
                r_.cell(r_.max_row, 8).fill = KEEP if i == keep else DROP
    for ws in (a, r_): ws.freeze_panes = 'C2'; ws.auto_filter.ref = ws.dimensions

rd = wb.create_sheet('Read me')
for l in [
    'Albums that exist twice IN FULL: every song of the catalogue is present two (or more) times — in MAM (read 13 Oct, with that day\'s ISRC changes) and in MadStreamer (website copy of ~03:00 today). Albums with only a few songs doubled are NOT on this list. Nothing was changed.',
    'Copies are told apart per song by record id (lower id = copy A). Usually one copy is an empty shell — no track numbers, filenames or ISRCs — and the other is complete.',
    'KEEP = the most complete copy (MAM: linked to MadStreamer first, then ISRCs, filenames, track numbers; MadStreamer: with barcodes first). REMOVE = the other copy. "3 / 0 / 0" means 3 track numbers, 0 filenames, 0 ISRCs.',
    'MadStreamer: here BOTH copies are usually complete and have barcodes, so the album is on the website twice. Removing a MadStreamer record also drops its plays/playlist entries — check before deleting; KEEP is the older copy.',
    'The "records" sheets list every record so the REMOVE ones can be found and deleted in FileMaker. Check an album before deleting its copy.',
]: rd.append([l])
rd.column_dimensions['A'].width = 150
for c in rd['A']: c.alignment = Alignment(wrap_text=True, vertical='top')
wb.save(out)
for db in res: print(db, len(res[db]), 'albums,', sum(n * (len(c) - 1) for _, n, c in res[db]), 'extra records')
