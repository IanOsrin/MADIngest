/**
 * lib/vision-drive.js — the "Vision" drive (remote FTP/SFTP server).
 *
 * Env (all required except port/base):
 *   VISION_PROTOCOL  sftp | ftp | ftps      (default sftp)
 *   VISION_HOST      hostname or IP
 *   VISION_PORT      default 22 for sftp, 21 for ftp/ftps
 *   VISION_USER
 *   VISION_PASS
 *   VISION_BASE_PATH server-side root the admin may browse (default "/") —
 *                    listings and downloads are jailed to this subtree.
 *
 * One connection per request (open → op → close): the admin tab is a
 * low-traffic browse tool and holding idle FTP control connections open
 * across requests is how you leak sockets on Render.
 */
import path from 'path'
import { Client as FtpClient } from 'basic-ftp'
import SftpClient from 'ssh2-sftp-client'

const PROTO = (process.env.VISION_PROTOCOL || 'sftp').toLowerCase()
const HOST = process.env.VISION_HOST || ''
const USER = process.env.VISION_USER || ''
const PASS = process.env.VISION_PASS || ''
const PORT = Number(process.env.VISION_PORT || (PROTO === 'sftp' ? 22 : 21))
const BASE = path.posix.normalize(process.env.VISION_BASE_PATH || '/')

export function visionStatus() {
  return {
    configured: !!(HOST && USER && PASS),
    protocol: PROTO,
    host: HOST ? HOST.replace(/^(.{3}).*(\..+)$/, '$1…$2') : null, // masked for the UI
    base: BASE,
  }
}

/** Resolve a browser-supplied path inside BASE; ".." can never escape it. */
function jail(rel) {
  const joined = path.posix.normalize(path.posix.join(BASE, String(rel || '/')))
  if (joined !== BASE && !joined.startsWith(BASE.endsWith('/') ? BASE : BASE + '/')) {
    throw new Error('Path escapes the Vision base directory')
  }
  return joined
}

/** Path relative to BASE, for display + navigation in the UI. */
function unjail(abs) {
  const rel = path.posix.relative(BASE, abs)
  return '/' + rel
}

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

/** List a directory. Returns { path, entries: [{name, type, size, modified}] } */
export async function visionList(rel = '/') {
  if (!visionStatus().configured) throw new Error('Vision drive is not configured (VISION_* env vars)')
  const abs = jail(rel)

  let entries
  if (PROTO === 'sftp') {
    entries = await withSftp(async (sftp) => {
      const items = await sftp.list(abs)
      return items.map((it) => ({
        name: it.name,
        type: it.type === 'd' ? 'dir' : 'file',
        size: it.size,
        modified: it.modifyTime ? new Date(it.modifyTime).toISOString() : null,
      }))
    })
  } else {
    entries = await withFtp(async (ftp) => {
      const items = await ftp.list(abs)
      return items.map((it) => ({
        name: it.name,
        type: it.isDirectory ? 'dir' : 'file',
        size: it.size,
        modified: it.modifiedAt ? it.modifiedAt.toISOString() : null,
      }))
    })
  }

  entries = entries
    .filter((e) => e.name !== '.' && e.name !== '..')
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1))
  return { path: unjail(abs), entries }
}

/** Stream one file into a writable (the HTTP response). Caller sets headers first. */
export async function visionDownloadTo(rel, writable) {
  if (!visionStatus().configured) throw new Error('Vision drive is not configured (VISION_* env vars)')
  const abs = jail(rel)
  if (PROTO === 'sftp') {
    await withSftp((sftp) => sftp.get(abs, writable))
  } else {
    await withFtp((ftp) => ftp.downloadTo(writable, abs))
  }
}
