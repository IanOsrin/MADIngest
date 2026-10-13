"""scripts/isrc-gap-compare-xlsx.py — workbook for scripts/isrc-gap-compare.mjs.
   python3 scripts/isrc-gap-compare-xlsx.py tmp/isrc-gap-compare.json ~/Downloads/ISRC-gaps-MadStreamer-MAM-cache.xlsx
"""
import json, sys, collections
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

d = json.load(open(sys.argv[1]))
blank = [r for r in d['rows'] if not r['cat'] and not r['title']]       # empty records: no catalogue, no title
rows = [r for r in d['rows'] if r['cat'] or r['title']]
def present(r): return {k: r[k] for k in ('ms', 'mam', 'cache') if r[k]}
ms_rows = [r for r in rows if r['where'] == 'MadStreamer']
mam_only = [r for r in rows if r['where'] == 'MAM only']

ms_fix, mam_fix, nowhere, conflicts, malformed = [], [], [], [], []
for r in rows:
    p = present(r)
    if len(set(p.values())) > 1: conflicts.append(r)
    for k in ('msRaw', 'mamRaw'):
        if r[k] and not r[k.replace('Raw', '')]: malformed.append((r, 'MadStreamer' if k == 'msRaw' else 'MAM', r[k]))
    if r['where'] == 'MadStreamer' and not r['ms']:
        src = r['mam'] or r['cache']
        if src and len(set(p.values())) == 1: ms_fix.append((r, 'MAM' if r['mam'] else 'metadata cache', src))
        elif not p: nowhere.append(r)
    if r['mamId'] and not r['mam']:
        src = r['ms'] or r['cache']
        if src and len(set(p.values())) == 1: mam_fix.append((r, 'MadStreamer' if r['ms'] else 'metadata cache', src))
    if r['where'] == 'MAM only' and not p: nowhere.append(r)

wb = Workbook()
def head(ws, cols, widths):
    ws.append(cols)
    for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='6D28D9')
    for i, w in enumerate(widths, 1): ws.column_dimensions[get_column_letter(i)].width = w
def fin(ws): ws.freeze_panes = 'D2'; ws.auto_filter.ref = ws.dimensions
BASE = ['Catalogue', 'Album', 'Song', 'Artist', '#', 'Filename', 'MadStreamer record', 'MAM record', 'Barcode & not hidden?']
BW = [15, 28, 30, 22, 5, 20, 11, 10, 12]
def base(r): return [r['cat'], r['album'], r['title'], r['artist'], r['seq'], r['file'], int(r['msId']) if r['msId'] else '', int(r['mamId']) if r['mamId'] else '', 'yes' if r['onSite'] else 'no']
show = lambda v: v if v else ('—' if v == '' else 'n/a')

s = wb.active; s.title = 'Summary'
s.append(['ISRC gaps across MadStreamer, MAM and the metadata cache']); s['A1'].font = Font(bold=True, size=13)
for row in [
    ['MadStreamer songs (the website\'s database, copy of ~03:00 today)', len(ms_rows)],
    ['  …of those paired with a MAM song (catalogue + Filename)', sum(1 for r in ms_rows if r['mamId'])],
    ['MAM songs with no MadStreamer twin', len(mam_only)],
    ['MadStreamer songs WITHOUT a valid ISRC', sum(1 for r in ms_rows if not r['ms'])],
    ['MAM songs WITHOUT a valid ISRC', sum(1 for r in rows if r['mamId'] and not r['mam'])],
    [],
    ['MadStreamer missing — MAM or the cache has it (sheet 2)', len(ms_fix)],
    ['  …from MAM', sum(1 for x in ms_fix if x[1] == 'MAM')],
    ['  …from the metadata cache only', sum(1 for x in ms_fix if x[1] != 'MAM')],
    ['MAM missing — MadStreamer or the cache has it (sheet 3)', len(mam_fix)],
    ['  …from MadStreamer', sum(1 for x in mam_fix if x[1] == 'MadStreamer')],
    ['  …from the metadata cache only', sum(1 for x in mam_fix if x[1] != 'MadStreamer')],
    ['No ISRC anywhere — needs one allocated (sheet 4)', len(nowhere)],
    ['  …of those in MadStreamer', sum(1 for r in nowhere if r['where'] == 'MadStreamer')],
    ['Different ISRCs for the same song (sheet 5)', len(conflicts)],
    ['Malformed ISRC values, e.g. "XX" (sheet 6)', len(malformed)],
    [],
    ['Empty MadStreamer records (no catalogue, no title) — left out of every sheet; record ids: ' + ', '.join(str(r['msId']) for r in blank), len(blank)],
]: s.append(row)
s.column_dimensions['A'].width = 70; s.column_dimensions['B'].width = 12

ws = wb.create_sheet('MadStreamer missing'); head(ws, BASE + ['ISRC to add', 'Found in', 'Done ✓'], BW + [16, 16, 8])
for r, src, v in sorted(ms_fix, key=lambda x: (x[0]['cat'] or '', str(x[0]['seq']))): ws.append(base(r) + [v, src, ''])
fin(ws)
ws = wb.create_sheet('MAM missing'); head(ws, BASE + ['ISRC to add', 'Found in', 'Done ✓'], BW + [16, 16, 8])
for r, src, v in sorted(mam_fix, key=lambda x: (x[0]['cat'] or '', str(x[0]['seq']))): ws.append(base(r) + [v, src, ''])
fin(ws)
ws = wb.create_sheet('Missing everywhere'); head(ws, BASE + ['Where the song is'], BW + [14])
for r in sorted(nowhere, key=lambda r: (r['where'] != 'MadStreamer', not r['onSite'], r['cat'] or '', str(r['seq']))): ws.append(base(r) + [r['where']])
fin(ws)
ws = wb.create_sheet('Conflicts'); head(ws, BASE + ['MadStreamer ISRC', 'MAM ISRC', 'Cache ISRC'], BW + [16, 16, 16])
for r in sorted(conflicts, key=lambda r: (r['cat'] or '', str(r['seq']))): ws.append(base(r) + [show(r['ms']), show(r['mam']), show(r['cache'])])
fin(ws)
ws = wb.create_sheet('Malformed'); head(ws, BASE + ['Database', 'Value held'], BW + [12, 20])
for r, db, v in sorted(malformed, key=lambda x: (x[0]['cat'] or '', str(x[0]['seq']))): ws.append(base(r) + [db, v])
fin(ws)
rd = wb.create_sheet('Read me')
for line in [
    'Where an ISRC is missing across the three sources: MadStreamer (the website\'s database — its nightly copy, ~03:00 today), MAM (Music Arena Master, read live) and the metadata cache (Ingrooves extract + ISRC register). Nothing was changed.',
    'Songs are paired MadStreamer ↔ MAM by catalogue + Filename; either ↔ the cache by catalogue + song title (ignoring case, accents, punctuation, bracketed bits), only when that title appears once on the cache album.',
    'An ISRC counts only if it has the 12-character shape CC-XXX-YY-NNNNN; anything else (e.g. "XX", a barcode pasted in) is treated as missing and listed on "Malformed".',
    '"MadStreamer missing" / "MAM missing": every other source that has a value agrees, so the ISRC can be copied across. Where the sources DISAGREE the song is on "Conflicts" instead — check those against the label copy / register before using either.',
    '"Missing everywhere": no source has an ISRC — these need one allocated. MadStreamer songs come first, and of those the ones with a barcode and not hidden first: they are on albums the site shows, and would appear as soon as they get an ISRC.',
    '"Barcode & not hidden?" = the MadStreamer song has a barcode (UPC) and is not set to Hide. The website shows a song only when it has an ISRC AND a barcode AND a cover, so a song without an ISRC is never on the site, whatever this column says.',
    '"n/a" in Conflicts = that source has no matching song; "—" = it has the song but no ISRC.',
]: rd.append([line])
rd.column_dimensions['A'].width = 140
for c in rd['A']: c.alignment = Alignment(wrap_text=True)
wb.save(sys.argv[2])
print(sys.argv[2], 'ms_fix', len(ms_fix), 'mam_fix', len(mam_fix), 'nowhere', len(nowhere), 'conflicts', len(conflicts), 'malformed', len(malformed))
