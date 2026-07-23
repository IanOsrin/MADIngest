/**
 * lib/vision-drive.js — the "Vision" drive.
 *
 * Vision is an S3-COMPATIBLE object store (custom endpoint, access/secret
 * key — the Cyberduck bookmark uses the Amazon S3 profile), with ftp/sftp
 * kept as alternate protocols in case a future drive speaks those.
 *
 * Env:
 *   VISION_PROTOCOL    s3 | sftp | ftp | ftps      (default s3)
 *   — s3 —
 *   VISION_ENDPOINT    e.g. https://41.79.222.199:1232 (http:// if no TLS)
 *   VISION_ACCESS_KEY
 *   VISION_SECRET_KEY
 *   VISION_BUCKET      optional: jail browsing to ONE bucket (else buckets
 *                      list as top-level folders)
 *   VISION_REGION      default us-east-1 (S3-compatibles rarely care)
 *   VISION_INSECURE_TLS=true to accept a self-signed certificate
 *   — ftp/sftp —
 *   VISION_HOST / VISION_PORT / VISION_USER / VISION_PASS / VISION_BASE_PATH
 *
 * Browse paths look like /bucket/folder/… ; every path is jailed (".." can
 * never escape, and with VISION_BUCKET set, neither can another bucket).
 */
import path from 'path'
import https from 'https'
import { Client as FtpClient } from 'basic-ftp'
import SftpClient from 'ssh2-sftp-client'
import { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'

const PROTO = (process.env.VISION_PROTOCOL || 's3').toLowerCase()

// ── s3 config ───────────────────────────────────────────────────────────────
const ENDPOINT = (process.env.VISION_ENDPOINT || '').replace(/\/$/, '')
const ACCESS_KEY = process.env.VISION_ACCESS_KEY || ''
const SECRET_KEY = process.env.VISION_SECRET_KEY || ''
const FIXED_BUCKET = (process.env.VISION_BUCKET || '').trim()
const REGION = process.env.VISION_REGION || 'us-east-1'
const INSECURE = String(process.env.VISION_INSECURE_TLS || '') === 'true'

let _s3 = null
function s3() {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      forcePathStyle: true, // custom endpoints don't do virtual-hosted buckets
      ...(INSECURE && ENDPOINT.startsWith('https')
        ? { requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ rejectUnauthorized: false }) }) }
        : {}),
    })
  }
  return _s3
}

// ── ftp/sftp config (alternate protocols) ───────────────────────────────────
const HOST = process.env.VISION_HOST || ''
const USER = process.env.VISION_USER || ''
const PASS = process.env.VISION_PASS || ''
const PORT = Number(process.env.VISION_PORT || (PROTO === 'sftp' ? 22 : 21))
const BASE = path.posix.normalize(process.env.VISION_BASE_PATH || '/')

export function visionStatus() {
  const configured = PROTO === 's3'
    ? !!(ENDPOINT && ACCESS_KEY && SECRET_KEY)
    : !!(HOST && USER && PASS)
  return {
    configured,
    protocol: PROTO,
    host: PROTO === 's3'
      ? (ENDPOINT ? ENDPOINT.replace(/^https?:\/\//, '').replace(/^(.{6}).*$/, '$1…') : null)
      : (HOST ? HOST.replace(/^(.{3}).*(\..+)$/, '$1…$2') : null),
    base: PROTO === 's3' ? (FIXED_BUCKET ? `/${FIXED_BUCKET}` : '/') : BASE,
  }
}

function notConfigured() {
  return new Error(PROTO === 's3'
    ? 'Vision drive is not configured — set VISION_ENDPOINT / VISION_ACCESS_KEY / VISION_SECRET_KEY'
    : 'Vision drive is not configured — set VISION_HOST / VISION_USER / VISION_PASS')
}

// ── s3 path handling ────────────────────────────────────────────────────────
// Browse path "/bucket/a/b" → { bucket:'bucket', prefix:'a/b/' }. With
// VISION_BUCKET set, the path is entirely inside that bucket.
function s3Parse(rel) {
  const clean = path.posix.normalize('/' + String(rel || '/')).replace(/^\/+/, '')
  if (clean.includes('..')) throw new Error('Invalid path')
  const parts = clean.split('/').filter(Boolean)
  if (FIXED_BUCKET) return { bucket: FIXED_BUCKET, key: parts.join('/') }
  const [bucket, ...rest] = parts
  return { bucket: bucket || null, key: rest.join('/') }
}

async function s3List(rel) {
  const { bucket, key } = s3Parse(rel)

  if (!bucket) {
    const out = await s3().send(new ListBucketsCommand({}))
    return {
      path: '/',
      entries: (out.Buckets || []).map((b) => ({
        name: b.Name, type: 'dir', size: null,
        modified: b.CreationDate ? b.CreationDate.toISOString() : null,
      })),
    }
  }

  const prefix = key ? key.replace(/\/?$/, '/') : ''
  const entries = []
  let token
  do {
    const out = await s3().send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token, MaxKeys: 1000,
    }))
    for (const p of out.CommonPrefixes || []) {
      entries.push({ name: p.Prefix.slice(prefix.length).replace(/\/$/, ''), type: 'dir', size: null, modified: null })
    }
    for (const o of out.Contents || []) {
      if (o.Key === prefix) continue // the folder marker itself
      entries.push({
        name: o.Key.slice(prefix.length), type: 'file', size: o.Size,
        modified: o.LastModified ? o.LastModified.toISOString() : null,
      })
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token && entries.length < 5000)

  const shownPath = FIXED_BUCKET ? '/' + (key || '') : `/${bucket}${key ? '/' + key : ''}`
  return { path: path.posix.normalize(shownPath), entries }
}

async function s3DownloadTo(rel, writable) {
  const { bucket, key } = s3Parse(rel)
  if (!bucket || !key) throw new Error('Not a file path')
  const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  await new Promise((resolve, reject) => {
    out.Body.on('error', reject)
    writable.on('error', reject)
    writable.on('finish', resolve)
    out.Body.pipe(writable, { end: false })
    out.Body.on('end', resolve)
  })
}

/**
 * Flat list of EVERY object in a bucket via paginated ListObjectsV2 (no
 * delimiter) — ~1 call per 1000 keys, so a 40k-file bucket indexes in ~40
 * calls instead of thousands of folder walks. Keys normalised to NFC. Returns
 * [{ path:'/bucket/key', key, size }].
 */
export async function visionAllKeys(bucket, { prefix = '', onProgress } = {}) {
  if (PROTO !== 's3') throw new Error('visionAllKeys requires the s3 protocol')
  const out = []
  let token
  do {
    const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token, MaxKeys: 1000 }))
    for (const o of r.Contents || []) {
      if (o.Key.endsWith('/')) continue // folder marker
      const key = o.Key.normalize('NFC')
      out.push({ path: `/${bucket}/${key}`, key, size: o.Size })
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined
    if (onProgress) onProgress(out.length)
  } while (token)
  return out
}

/**
 * Open a byte stream for an object, honouring an HTTP Range header so a browser
 * <audio> element can seek within a large WAV. Returns the S3 GetObject result
 * ({ Body, ContentLength, ContentRange, ContentType, ... }).
 */
export async function visionOpen(rel, range) {
  if (PROTO !== 's3') throw new Error('visionOpen requires the s3 protocol')
  const { bucket, key } = s3Parse(rel)
  if (!bucket || !key) throw new Error('Not a file path')
  return s3().send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range || undefined }))
}

/** Object size + type for headers (best effort). */
export async function visionStat(rel) {
  if (PROTO !== 's3') return null
  try {
    const { bucket, key } = s3Parse(rel)
    if (!bucket || !key) return null
    const out = await s3().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }))
    const o = (out.Contents || [])[0]
    return o && o.Key === key ? { size: o.Size } : null
  } catch { return null }
}

// ── ftp/sftp implementations (alternate protocols) ──────────────────────────
function jail(rel) {
  const joined = path.posix.normalize(path.posix.join(BASE, String(rel || '/')))
  if (joined !== BASE && !joined.startsWith(BASE.endsWith('/') ? BASE : BASE + '/')) {
    throw new Error('Path escapes the Vision base directory')
  }
  return joined
}
const unjail = (abs) => '/' + path.posix.relative(BASE, abs)

async function withSftp(fn) {
  const sftp = new SftpClient()
  try {
    await sftp.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 15000 })
    return await fn(sftp)
  } finally {
    await sftp.end().catch(() => {})
  }
}

async function withFtp(fn) {
  const client = new FtpClient(15000)
  try {
    await client.access({ host: HOST, port: PORT, user: USER, password: PASS, secure: PROTO === 'ftps' })
    return await fn(client)
  } finally {
    client.close()
  }
}

async function ftpList(rel) {
  const abs = jail(rel)
  let entries
  if (PROTO === 'sftp') {
    entries = await withSftp(async (sftp) => (await sftp.list(abs)).map((it) => ({
      name: it.name, type: it.type === 'd' ? 'dir' : 'file', size: it.size,
      modified: it.modifyTime ? new Date(it.modifyTime).toISOString() : null,
    })))
  } else {
    entries = await withFtp(async (ftp) => (await ftp.list(abs)).map((it) => ({
      name: it.name, type: it.isDirectory ? 'dir' : 'file', size: it.size,
      modified: it.modifiedAt ? it.modifiedAt.toISOString() : null,
    })))
  }
  return { path: unjail(abs), entries: entries.filter((e) => e.name !== '.' && e.name !== '..') }
}

async function ftpDownloadTo(rel, writable) {
  const abs = jail(rel)
  if (PROTO === 'sftp') await withSftp((sftp) => sftp.get(abs, writable))
  else await withFtp((ftp) => ftp.downloadTo(writable, abs))
}

// ── public API ──────────────────────────────────────────────────────────────
export async function visionList(rel = '/') {
  if (!visionStatus().configured) throw notConfigured()
  const out = PROTO === 's3' ? await s3List(rel) : await ftpList(rel)
  out.entries.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.type === 'dir' ? -1 : 1)
  return out
}

export async function visionDownloadTo(rel, writable) {
  if (!visionStatus().configured) throw notConfigured()
  if (PROTO === 's3') await s3DownloadTo(rel, writable)
  else await ftpDownloadTo(rel, writable)
}
