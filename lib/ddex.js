import AdmZip from 'adm-zip'
import { parseStringPromise } from 'xml2js'
import { parseDDEXErn382 } from './ddex-ern382.js'
import { parseDDEXErn41  } from './ddex-ern41.js'

// Decode XML buffer — handles UTF-8, UTF-16 LE, and UTF-16 BE
// Always strips the BOM character that would break the XML parser
function decodeXml(buf) {
  let str
  if (buf[0] === 0xFF && buf[1] === 0xFE) str = buf.toString('utf16le')
  else if (buf[0] === 0xFE && buf[1] === 0xFF) str = buf.swap16().toString('utf16le')
  else str = buf.toString('utf8')
  return str.replace(/^﻿/, '')  // strip BOM
}

// Strip namespace prefixes from all keys recursively so callers use plain field names
function stripNs(obj) {
  if (Array.isArray(obj)) return obj.map(stripNs)
  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k.replace(/^[a-zA-Z_][\w]*:/, '')] = stripNs(v)
    }
    return result
  }
  return obj
}

export async function parseDDEXPackage(zipBuffer) {
  const zip     = new AdmZip(zipBuffer)
  const entries = zip.getEntries()

  const xmlEntry = entries.find(e =>
    e.entryName.endsWith('.xml') && !e.entryName.includes('__MACOSX')
  )
  if (!xmlEntry) throw new Error('No XML file found in DDEX package')

  const xmlStr = decodeXml(xmlEntry.getData())

  const parsed = await parseStringPromise(xmlStr, {
    explicitArray:   false,
    mergeAttrs:      true,
    explicitCharkey: false,
  })

  // Extract version from namespace before stripping
  const ns      = xmlStr.match(/xmlns(?::ern)?="([^"]+)"/)?.[1]
              || xmlStr.match(/MessageSchemaVersionId="([^"]+)"/)?.[1] || ''
  const version = ns.includes('383') ? '383'
    : ns.includes('382') ? '382'
    : ns.includes('41')  ? '41'
    : 'unknown'

  // Build file map: basename (lowercase) → Buffer
  const fileMap = {}
  entries.forEach(e => {
    if (!e.isDirectory) {
      const basename = e.name.toLowerCase()
      fileMap[basename] = e.getData()
    }
  })

  // Strip ns prefixes so parsers use plain names regardless of prefix conventions
  const rawRoot = parsed['ern:NewReleaseMessage'] || parsed['NewReleaseMessage'] || Object.values(parsed)[0]
  const root    = stripNs(rawRoot)

  let tracks
  if (version === '382') tracks = parseDDEXErn382(root, fileMap)
  else if (version === '383' || version === '41') tracks = parseDDEXErn41(root, fileMap)
  else throw new Error(`Unsupported DDEX version namespace: ${ns}`)

  return { version, tracks, fileMap }
}

/**
 * Parse a raw DDEX XML string (no ZIP, no audio files).
 * Useful for previewing metadata before you have the full package.
 */
export async function parseDDEXXml(xmlStr) {
  const parsed = await parseStringPromise(xmlStr, {
    explicitArray:   false,
    mergeAttrs:      true,
    explicitCharkey: false,
  })

  const ns      = xmlStr.match(/xmlns(?::ern)?="([^"]+)"/)?.[1]
              || xmlStr.match(/MessageSchemaVersionId="([^"]+)"/)?.[1] || ''
  const version = ns.includes('383') ? '383'
    : ns.includes('382') ? '382'
    : ns.includes('41')  ? '41'
    : 'unknown'

  const rawRoot = parsed['ern:NewReleaseMessage'] || parsed['NewReleaseMessage'] || Object.values(parsed)[0]
  const root    = stripNs(rawRoot)

  let tracks
  if (version === '382') tracks = parseDDEXErn382(root, {})
  else if (version === '383' || version === '41') tracks = parseDDEXErn41(root, {})
  else throw new Error(`Unsupported DDEX version namespace: ${ns}`)

  return { version, tracks }
}
