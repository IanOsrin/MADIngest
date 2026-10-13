"""scripts/isrc-cache-not-on-album.py — the songs on Songs-missing-from-cache-albums marked "not on the cache album":
the album is in the metadata cache, the song isn't, its ISRC links to nothing on that album and no title there is
close (Ian, 2026-10-13: "Genuinely not on the cache album"). Read-only.

Adds, per song: is the title anywhere ELSE in the cache (another catalogue), is its ISRC anywhere in the cache, and
what the cache album has at the same track number; per album: how many songs each side has.

   python3 scripts/isrc-cache-not-on-album.py ~/Downloads/Songs-missing-from-cache-albums-2026-10-13.xlsx tmp/metadata-extract.json out.xlsx
"""
import json, sys, re, unicodedata, collections
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

src, cache_f, out = sys.argv[1:4]
V = lambda v: (lambda s: s if re.fullmatch(r'[A-Z]{2}[A-Z0-9]{3}\d{7}', s) else '')(re.sub(r'[\s-]', '', str(v or '')).upper())
cat = lambda c: re.sub(r'[^A-Za-z0-9]', '', str(c or '')).upper()
asc = lambda s: unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
loose = lambda s: re.sub(r'[^a-z0-9]+', '', re.sub(r'\(.*?\)|\[.*?\]', ' ', asc(s)))

cache = json.load(open(cache_f)); cache = cache if isinstance(cache, list) else cache['rows']
alb = collections.defaultdict(list); by_title = collections.defaultdict(list); by_isrc = collections.defaultdict(list)
for c in cache:
    if not c.get('catalogue') or not c.get('track_name'): continue
    alb[cat(c['catalogue'])].append(c); by_title[loose(c['track_name'])].append(c)
    if V(c.get('isrc')): by_isrc[V(c['isrc'])].append(c)

wb_in = load_workbook(src, read_only=True)
res = {}
for db in ('MadStreamer', 'MAM'):
    sh = next(n for n in wb_in.sheetnames if n.startswith(db + ' ('))
    it = wb_in[sh].iter_rows(values_only=True); hdr = next(it)
    rows = [dict(zip(hdr, r)) for r in it if r[9] == 'not on the cache album']
    for r in rows:
        elsewhere = [c for c in by_title.get(loose(r['Song']), []) if cat(c['catalogue']) != cat(r['Catalogue'])]
        r['elsewhere'] = '; '.join(dict.fromkeys(f"{c['catalogue']} — {c.get('album_title')} ({c.get('isrc') or 'no ISRC'})" for c in elsewhere[:4]))
        r['elseIsrc'] = next((c.get('isrc') for c in elsewhere if V(c.get('isrc'))), '')
        isrc_hit = by_isrc.get(V(r['ISRC now']), []) if r['ISRC now'] and r['ISRC now'] != '—' else []
        r['isrcIn'] = '; '.join(f"{c['track_name']} ({c['catalogue']})" for c in isrc_hit[:3])
        a = alb[cat(r['Catalogue'])]
        r['cacheCount'] = len(a)
        if r['elsewhere']: r['kind'] = 'title is in the cache on ANOTHER catalogue'
        elif isrc_hit: r['kind'] = 'ISRC is in the cache under another title'
        else: r['kind'] = 'nowhere in the cache'
    res[db] = rows

# per album: songs in the database vs songs on the cache album
def per_album(db):
    g = collections.defaultdict(list)
    for r in res[db]: g[cat(r['Catalogue'])].append(r)
    return g

wb = Workbook(); H = PatternFill('solid', fgColor='6D28D9')
KINDS = {'title is in the cache on ANOTHER catalogue': 'E0F2FE', 'ISRC is in the cache under another title': 'FEF9C3', 'nowhere in the cache': 'FEE2E2'}
s = wb.active; s.title = 'Summary'
s.append(['Songs genuinely not on their cache album (13 Oct 2026)']); s['A1'].font = Font(bold=True, size=13)
s.append([]); s.append(['', 'MadStreamer', 'MAM'])
for k in KINDS:
    s.append([k, sum(1 for r in res['MadStreamer'] if r['kind'] == k), sum(1 for r in res['MAM'] if r['kind'] == k)])
    s.cell(s.max_row, 1).fill = PatternFill('solid', fgColor=KINDS[k])
s.append(['Total songs', len(res['MadStreamer']), len(res['MAM'])])
s.append(['  …albums', len(per_album('MadStreamer')), len(per_album('MAM'))])
s.append(['  …MadStreamer songs on the website now', sum(1 for r in res['MadStreamer'] if r['On website?'] == 'yes'), ''])
s.append(['  …with no ISRC', sum(1 for r in res['MadStreamer'] if r['ISRC now'] in ('—', None, '')), sum(1 for r in res['MAM'] if r['ISRC now'] in ('—', None, ''))])
s.column_dimensions['A'].width = 70; s.column_dimensions['B'].width = 13; s.column_dimensions['C'].width = 13

COLS = ['Catalogue', 'Album', 'Song', 'Artist', '#', 'Filename', 'Record', 'ISRC now', 'On website?', 'What it looks like',
        'Same title elsewhere in the cache (catalogue — album (ISRC))', 'Its ISRC is in the cache as', 'Cache title at the same #', 'Cache album', 'Songs on cache album']
W = [14, 26, 30, 18, 4, 13, 9, 15, 8, 30, 50, 34, 30, 26, 8]
for db in ('MadStreamer', 'MAM'):
    ws = wb.create_sheet(f'{db} ({len(res[db])})'); ws.append(COLS)
    for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = H; c.alignment = Alignment(wrap_text=True, vertical='top')
    for i, w in enumerate(W, 1): ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = 'D2'
    for r in sorted(res[db], key=lambda r: (list(KINDS).index(r['kind']), cat(r['Catalogue']), str(r['#']).zfill(4))):
        ws.append([r['Catalogue'], r['Album'], r['Song'], r['Artist'], r['#'], r['Filename'], r['Record'], r['ISRC now'], r['On website?'], r['kind'],
                   r['elsewhere'], r['isrcIn'], r['Cache title at the same #'], r['Cache album'], r['cacheCount']])
        ws.cell(ws.max_row, 10).fill = PatternFill('solid', fgColor=KINDS[r['kind']])
    ws.auto_filter.ref = ws.dimensions

ws = wb.create_sheet('By album')
ws.append(['Database', 'Catalogue', 'Album', 'Songs not on the cache album', 'Songs on cache album', 'The songs'])
for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = H
for i, w in enumerate([12, 14, 34, 12, 12, 110], 1): ws.column_dimensions[get_column_letter(i)].width = w
for db in ('MadStreamer', 'MAM'):
    for k, rs in sorted(per_album(db).items(), key=lambda kv: -len(kv[1])):
        ws.append([db, rs[0]['Catalogue'], rs[0]['Album'], len(rs), rs[0]['Songs on cache album'], '; '.join(str(r['Song']) for r in rs)])
ws.auto_filter.ref = ws.dimensions; ws.freeze_panes = 'C2'

rd = wb.create_sheet('Read me')
for l in [
    'Songs whose catalogue IS in the metadata cache, but no song on that cache album has the same (or a close) title and the song\'s ISRC isn\'t on that album either. MadStreamer = website copy of ~03:00 today (titles before today\'s 525 renames — none of those are on this list). Nothing was changed.',
    '"title is in the cache on ANOTHER catalogue" — the same song title is on a different cache album: likely a compilation / reissue track, or a song filed under the wrong catalogue. The ISRC the cache has there is shown.',
    '"ISRC is in the cache under another title" — the cache knows the ISRC, but on a different song or album.',
    '"nowhere in the cache" — neither the title nor the ISRC is in the cache: a bonus track or longer reissue the cache never got, or a wrong catalogue number.',
    '"By album": where many songs of one album are missing, the cache usually holds a shorter edition (e.g. the LP vs the CD) — compare "Songs on cache album".',
]: rd.append([l])
rd.column_dimensions['A'].width = 150
for c in rd['A']: c.alignment = Alignment(wrap_text=True, vertical='top')
wb.save(out)
for db in res: print(db, len(res[db]), collections.Counter(r['kind'] for r in res[db]).most_common(), 'albums', len(per_album(db)))
