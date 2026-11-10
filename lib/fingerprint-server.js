// lib/fingerprint-server.js — the Azure fingerprint server behind Check Audio (Ian, 2026-11-10).
//
// The matcher needs about 4 GB of memory, more than GalloIngest's own server has, so it runs on its own machine:
// an Azure VM holding the fingerprints loaded from Vision. It costs money while it is on, so the tab can switch it
// on and off. This file does the two things GalloIngest needs from it:
//   1. power — read / start / deallocate the VM through Azure's API, with a login that can do only that
//   2. checks — send audio to the service on the VM and get the matches back
//
//   FP_SERVER_URL, FP_SERVER_TOKEN          the service on the VM (https, shared token)
//   FP_AZURE_TENANT_ID, FP_AZURE_CLIENT_ID, FP_AZURE_CLIENT_SECRET, FP_AZURE_SUBSCRIPTION_ID     the on/off login
//   FP_AZURE_RESOURCE_GROUP, FP_AZURE_VM    default to the VM made on 2026-11-10
import { createReadStream, statSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

const env = (k, fallback = '') => String(process.env[k] || fallback).trim()
const serverUrl = () => env('FP_SERVER_URL').replace(/\/+$/, '')
const token = () => env('FP_SERVER_TOKEN')
const CHECK_MS = 15 * 60 * 1000
const COMPUTE_API = '2024-07-01'

export const serverConfigured = () => !!(serverUrl() && token())
const canSwitch = () => ['FP_AZURE_TENANT_ID', 'FP_AZURE_CLIENT_ID', 'FP_AZURE_CLIENT_SECRET', 'FP_AZURE_SUBSCRIPTION_ID'].every((k) => env(k))

// ── power ─────────────────────────────────────────────────────────────────────────────────────────────
let azureToken = null
async function azureAccess() {
  if (azureToken && azureToken.until > Date.now() + 60_000) return azureToken.value
  const r = await fetch(`https://login.microsoftonline.com/${env('FP_AZURE_TENANT_ID')}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('FP_AZURE_CLIENT_ID'), client_secret: env('FP_AZURE_CLIENT_SECRET'), scope: 'https://management.azure.com/.default' }),
    signal: AbortSignal.timeout(15_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error('Azure refused the on/off login.')
  azureToken = { value: j.access_token, until: Date.now() + Number(j.expires_in || 3000) * 1000 }
  return azureToken.value
}

async function azure(method, action) {
  const vm = `/subscriptions/${env('FP_AZURE_SUBSCRIPTION_ID')}/resourceGroups/${env('FP_AZURE_RESOURCE_GROUP', 'mad-fingerprint-trial')}/providers/Microsoft.Compute/virtualMachines/${env('FP_AZURE_VM', 'fp-trial')}`
  const r = await fetch(`https://management.azure.com${vm}/${action}?api-version=${COMPUTE_API}`, {
    method, headers: { Authorization: `Bearer ${await azureAccess()}` }, signal: AbortSignal.timeout(20_000),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`Azure answered ${r.status}${body.error?.code ? ` (${body.error.code})` : ''}.`)
  return body
}

const POWER = { running: 'on', starting: 'starting', stopping: 'stopping', deallocating: 'stopping', deallocated: 'off', stopped: 'off' }
let expected = null      // Azure takes a few seconds to report a switch it has just accepted
let cached = null

async function readPower() {
  const view = await azure('GET', 'instanceView')
  const code = (view.statuses || []).map((s) => s.code || '').find((c) => c.startsWith('PowerState/'))
  const power = POWER[String(code || '').split('/')[1]] || 'unknown'
  // While it changes state Azure can report no power state at all, so 'unknown' counts as still changing.
  if (expected && expected.until > Date.now() && (power === expected.from || power === 'unknown')) return expected.showing
  return power
}

async function readService() {
  try {
    const r = await fetch(`${serverUrl()}/health`, { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(5_000) })
    const j = await r.json()
    return j.ok ? { service: j.state, tracks: j.tracks } : { service: 'unreachable', tracks: null }
  } catch { return { service: 'unreachable', tracks: null } }
}

/** { canSwitch, power: on|starting|stopping|off|unknown|null, service: ready|loading|unreachable|null, tracks, error? } */
export async function serverStatus() {
  if (cached && Date.now() - cached.at < 3000) return cached.value
  let power = null, error = null
  if (canSwitch()) { try { power = await readPower() } catch (err) { power = 'unknown'; error = err.message } }
  const { service, tracks } = power === null || power === 'on' || power === 'unknown' ? await readService() : { service: null, tracks: null }
  const value = { canSwitch: canSwitch(), power, service, tracks, ...(error ? { error } : {}) }
  cached = { at: Date.now(), value }
  return value
}

export async function switchServer(on) {
  if (!canSwitch()) throw new Error('The on/off login isn’t set up on this server.')
  await azure('POST', on ? 'start' : 'deallocate')
  expected = on ? { from: 'off', showing: 'starting', until: Date.now() + 45_000 } : { from: 'on', showing: 'stopping', until: Date.now() + 45_000 }
  cached = null
  return serverStatus()
}

// ── checks ────────────────────────────────────────────────────────────────────────────────────────────
/** Send one audio file to the service; resolves { seconds, scanned, tracks, ms, matches }. */
export function checkOnServer(file) {
  return new Promise((resolve, reject) => {
    const url = new URL('/check', serverUrl())
    url.searchParams.set('ext', path.extname(file) || '.audio')
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'POST', timeout: CHECK_MS,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(file).size },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        let j
        try { j = JSON.parse(body) } catch { return reject(new Error('The fingerprint server gave an unreadable answer.')) }
        return j.ok ? resolve(j) : reject(new Error(j.error || 'The fingerprint server could not check that audio.'))
      })
    })
    req.on('timeout', () => req.destroy(new Error('it took too long')))
    req.on('error', (err) => reject(new Error(`Could not reach the fingerprint server: ${err.message}`)))
    createReadStream(file).on('error', reject).pipe(req)
  })
}
