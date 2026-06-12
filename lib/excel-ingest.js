import * as XLSX from 'xlsx'

const COLUMN_MAP = {
  // title
  'title': 'title', 'track title': 'title', 'track name': 'title',
  'song title': 'title', 'song': 'title',
  'tracktitle': 'title', 'trackname': 'title', 'songtitle': 'title',
  'song name': 'title', 'songname': 'title', 'name': 'title',
  // version_title
  'version': 'version_title', 'mix': 'version_title', 'edit': 'version_title',
  'version title': 'version_title', 'track version': 'version_title',
  'versiontitle': 'version_title', 'trackversion': 'version_title',
  'mix version': 'version_title', 'mixversion': 'version_title',
  // artist_name
  'artist': 'artist_name', 'artist name': 'artist_name',
  'performer': 'artist_name', 'main artist': 'artist_name',
  'track artist': 'artist_name',
  'artistname': 'artist_name', 'mainartist': 'artist_name',
  'trackartist': 'artist_name', 'act': 'artist_name',
  // featuring
  'featuring': 'featuring', 'feat': 'featuring',
  'featured artist': 'featuring', 'ft': 'featuring',
  'featuredartist': 'featuring', 'feat.': 'featuring', 'ft.': 'featuring',
  // credits
  'composer': 'composer', 'composers': 'composer',
  'writer': 'composer', 'writers': 'composer', 'songwriter': 'composer', 'songwriters': 'composer',
  'writers / composers': 'composer', 'writers/composers': 'composer',
  'composers / writers': 'composer', 'composers/writers': 'composer',
  'lyricist': 'lyricist', 'lyric writer': 'lyricist',
  'producer': 'producer', 'producers': 'producer',
  // album
  'album': 'album_title', 'album title': 'album_title', 'release title': 'album_title',
  'albumtitle': 'album_title', 'releasetitle': 'album_title', 'album name': 'album_title',
  'albumname': 'album_title',
  // album artist
  'album artist': 'album_artist', 'albumartist': 'album_artist',
  // ids
  'upc': 'album_upc', 'barcode': 'album_upc', 'ean': 'album_upc',
  'cat no': 'catalogue', 'catalogue': 'catalogue',
  'catalogue number': 'catalogue', 'cat#': 'catalogue', 'cat. #': 'catalogue',
  'album catalogue number': 'catalogue', 'album catalogue no': 'catalogue',
  'cataloguenumber': 'catalogue', 'catalogno': 'catalogue', 'catno': 'catalogue',
  'cat number': 'catalogue', 'catnumber': 'catalogue', 'catalog': 'catalogue',
  'catalog number': 'catalogue', 'catalognumber': 'catalogue',
  'isrc': 'isrc', 'isrc code': 'isrc', 'isrc #': 'isrc', 'isrc number': 'isrc',
  'isrc no': 'isrc', 'isrc no.': 'isrc', 'track isrc': 'isrc',
  'isrccode': 'isrc', 'isrcnumber': 'isrc', 'trackisrc': 'isrc',
  'iswc': 'iswc',
  // label / publisher
  'label': 'label_name', 'record label': 'label_name',
  'recordlabel': 'label_name', 'labelname': 'label_name',
  'publisher': 'publisher', 'publishers': 'publisher',
  'music publisher': 'publisher', 'musicpublisher': 'publisher',
  // track metadata
  // sequence number (written to FM 'Sequence Number' field)
  'sequence': 'sequence_no', 'sequence number': 'sequence_no', 'sequence no': 'sequence_no',
  'sequence no.': 'sequence_no', 'seq': 'sequence_no', 'seq no': 'sequence_no',
  'seq #': 'sequence_no', 'seq.': 'sequence_no', 'track seq': 'sequence_no',
  'sequencenumber': 'sequence_no', 'trackseq': 'sequence_no',
  // track number
  'track': 'track_number', 'track no': 'track_number',
  'track number': 'track_number', '#': 'track_number',
  'tracknumber': 'track_number', 'trackno': 'track_number',
  'disc': 'disc_number', 'disc no': 'disc_number', 'cd': 'disc_number',
  'year': 'year', 'release year': 'year', 'date': 'year',
  'release date': 'year',
  'genre': 'genre', 'track genre': 'genre', 'album genre': 'genre',
  'subgenre': 'subgenre', 'sub-genre': 'subgenre', 'style': 'subgenre',
  'bpm': 'bpm', 'tempo': 'bpm',
  'key': 'key_sig', 'key sig': 'key_sig', 'musical key': 'key_sig',
  'mood': 'mood',
  'language': 'language', 'audio language': 'language',
  'language code': 'language',
  'explicit': 'explicit', 'parental advisory': 'explicit',
  'duration': 'duration_sec',
  // rights
  'territory': 'territories', 'territories': 'territories',
  'rights territory': 'territories',
  'sync': 'sync_licensed', 'sync licensed': 'sync_licensed',
  'sync cleared': 'sync_licensed',
  'rights holder': 'rights_holder', 'master rights': 'rights_holder',
  // ℗ / © lines — go to their own FM fields (pLine / cLine)
  'p line': 'p_line', '℗ line': 'p_line', 'p-line': 'p_line', 'pline': 'p_line',
  'album p line': 'p_line', 'album ℗ line': 'p_line',
  'c line': 'c_line', '© line': 'c_line', 'c-line': 'c_line', 'cline': 'c_line',
  'album c line': 'c_line', 'album © line': 'c_line', 'copyright line': 'c_line',
  'rights year': 'rights_year', 'copyright year': 'rights_year',
  '℗ year': 'rights_year',
  // PRO
  'pro': 'pro_name', 'pro name': 'pro_name', 'collecting society': 'pro_name',
  'ipi': 'pro_ipi', 'ipi number': 'pro_ipi',
  // submission
  'email': 'submitter_email', 'contact email': 'submitter_email',
  'notes': 'notes', 'comments': 'notes',
}

const BOOLEAN_FIELDS  = new Set(['explicit', 'sync_licensed'])
const INTEGER_FIELDS  = new Set(['track_number', 'disc_number', 'bpm', 'year', 'rights_year'])

export function parseTrackSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: false })

  // Prefer a sheet named 'ingest'; if it's empty or absent, fall back to
  // the first sheet that actually contains rows.
  const nameOrder = [
    wb.SheetNames.find(n => n.toLowerCase() === 'ingest'),
    ...wb.SheetNames
  ].filter(Boolean).filter((n, i, arr) => arr.indexOf(n) === i)

  let sheetName = wb.SheetNames[0]
  for (const name of nameOrder) {
    if (XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null }).length > 0) {
      sheetName = name
      break
    }
  }

  const ws = wb.Sheets[sheetName]
  const rowDefs = ws['!rows'] || []  // row visibility metadata
  const rows    = XLSX.utils.sheet_to_json(ws, { defval: null })

  const errors   = []
  const warnings = []
  const parsed   = []

  rows.forEach((row, i) => {
    const rowNum = i + 2  // 1-indexed + header
    // Skip rows hidden by an Excel filter
    if (rowDefs[i + 1]?.hidden) return
    const mapped = {}
    const unmapped = []

    Object.entries(row).forEach(([col, val]) => {
      // Normalise: lowercase, trim, collapse runs of whitespace/underscores to single space
      const normCol = col.toLowerCase().trim().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
      const key = COLUMN_MAP[normCol] ?? COLUMN_MAP[normCol.replace(/\s/g, '')]
      if (key) {
        mapped[key] = val
      } else {
        unmapped.push(col)
      }
    })

    // Required fields
    if (!mapped.title)       errors.push(`Row ${rowNum}: missing Track Title`)
    if (!mapped.artist_name) errors.push(`Row ${rowNum}: missing Artist`)

    // Parse duration: '3:45' or '3:45.0' → 225, or raw number passthrough
    if (mapped.duration_sec != null) {
      const v = String(mapped.duration_sec).trim()
      if (v.includes(':')) {
        const parts = v.split(':').map(Number)
        mapped.duration_sec = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts[0] * 60 + parts[1]
      } else {
        mapped.duration_sec = parseFloat(v) || null
      }
    }

    // Normalize year: might be "2024-01-15" or a Date serial
    if (mapped.year != null) {
      const s = String(mapped.year)
      const m = s.match(/(\d{4})/)
      mapped.year = m ? parseInt(m[1], 10) : null
    }

    // ISRC — always a string; strip whitespace and normalise dashes
    if (mapped.isrc != null) {
      mapped.isrc = String(mapped.isrc).trim().toUpperCase().replace(/\s+/g, '')
      if (!mapped.isrc) mapped.isrc = null
    }

    // Sequence number — integer
    if (mapped.sequence_no != null) {
      mapped.sequence_no = parseInt(String(mapped.sequence_no), 10) || null
    }

    // Normalize track_number: "4/12" → 4
    if (mapped.track_number != null) {
      const s = String(mapped.track_number).split('/')[0]
      mapped.track_number = parseInt(s, 10) || null
    }

    // Integer fields
    INTEGER_FIELDS.forEach(f => {
      if (mapped[f] != null && f !== 'track_number' && f !== 'year') {
        mapped[f] = parseInt(String(mapped[f]), 10) || null
      }
    })

    // Boolean fields
    BOOLEAN_FIELDS.forEach(f => {
      if (mapped[f] !== undefined && mapped[f] !== null) {
        const v = String(mapped[f]).toLowerCase().trim()
        mapped[f] = ['yes', 'true', '1', 'e', 'explicit', 'cleared', 'sync'].includes(v)
      }
    })

    if (unmapped.length) {
      warnings.push(`Row ${rowNum}: unrecognised columns: ${unmapped.join(', ')}`)
    }

    parsed.push({ _row: rowNum, ...mapped })
  })

  // Sort by sequence number; rows without one go to the end
  parsed.sort((a, b) => {
    const aSeq = a.sequence_no ?? Infinity
    const bSeq = b.sequence_no ?? Infinity
    return aSeq - bSeq
  })

  return { rows: parsed, errors, warnings }
}
