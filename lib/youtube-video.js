/**
 * lib/youtube-video.js — MAD Music → YouTube video generator.
 *
 * Ported from the MadMusic repo's scripts/youtube/generate-videos.mjs so the
 * admin YouTube tab can drive it. Renders upload-ready videos from owned
 * assets only: S3 artwork + S3 audio + MadStreamer metadata. Two formats:
 *
 *   art-track — 1920×1080: ambient-blur sleeve background, sharp sleeve left,
 *               title/artist/year·genre right, waveform strip, site watermark.
 *               Full track by default; `excerpt` clips to N seconds.
 *   short     — 1080×1920 vertical, 30 s (starts `shortOffset` seconds in so
 *               Shorts skip intros), same visual language + site CTA.
 *
 * Every video gets a .txt sidecar: suggested YouTube title, description with
 * the track's share link, and tags — paste into YouTube Studio on upload.
 *
 * Desktop-only: text overlays render via macOS AppKit (scripts/render-overlay
 * .jxa.js) because the Homebrew ffmpeg build has no drawtext filter. Requires
 * ffmpeg on PATH. checkRenderSupport() reports both preconditions.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSongForVideo } from './madstreamer.js'

const execFileP = promisify(execFile)

const OVERLAY_RENDERER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'render-overlay.jxa.js')

// YouTube content is public: links must ALWAYS point at prod. Never inherit
// APP_URL — a localhost APP_URL once put localhost links into uploaded video
// descriptions on the MadMusic side.
const SITE = (process.env.YT_SITE_URL || 'https://musicafricadirect.com').replace(/\/+$/, '')

// Hosted (Linux) runs on Render's ephemeral disk — /tmp, downloaded via the
// tab's links. Desktop keeps the pilot folder.
export const DEFAULT_OUT_DIR = process.env.YT_OUT_DIR ||
  (process.platform === 'darwin' ? join(homedir(), 'Downloads', 'mad-youtube-pilot') : '/tmp/mad-youtube')

// Encoder preset: 'medium' for quality on the desktop; the hosted starter
// instance can set YT_X264_PRESET=veryfast for CPU/RAM headroom.
const X264_PRESET = process.env.YT_X264_PRESET || 'medium'

// Overlay fonts for the Linux drawtext path (Liberation Sans is
// metric-compatible with the Arial the AppKit path uses).
const FONT_BOLD = process.env.YT_FONT_BOLD || '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
const FONT_REG  = process.env.YT_FONT_REGULAR || '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'

// ── environment support ──────────────────────────────────────────────────────
// Two overlay engines: macOS renders text via AppKit (Homebrew ffmpeg has no
// drawtext filter); everywhere else uses ffmpeg drawtext (the Docker image's
// Debian ffmpeg has it).
let _drawtext = null
async function hasDrawtext() {
  if (_drawtext !== null) return _drawtext
  try {
    const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-filters'])
    _drawtext = /\bdrawtext\b/.test(stdout)
  } catch {
    _drawtext = false
  }
  return _drawtext
}

export async function checkRenderSupport() {
  const problems = []
  try {
    await execFileP('ffmpeg', ['-version'])
  } catch {
    problems.push('ffmpeg not found on PATH (brew install ffmpeg).')
    return { ok: false, problems }
  }
  if (process.platform !== 'darwin') {
    if (!(await hasDrawtext())) {
      problems.push('This ffmpeg build has no drawtext filter (text overlays) — install an ffmpeg with libfreetype.')
    } else if (!existsSync(FONT_REG) || !existsSync(FONT_BOLD)) {
      problems.push('Overlay fonts missing — install fonts-liberation or set YT_FONT_REGULAR / YT_FONT_BOLD.')
    }
  }
  return { ok: problems.length === 0, problems }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

async function renderOverlayPng(spec) {
  await execFileP('osascript', ['-l', 'JavaScript', OVERLAY_RENDERER, JSON.stringify(spec)])
  return spec.out
}

// Escape a path for use inside a single-quoted ffmpeg filter option.
const fesc = p => String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Turn an overlay spec ({ width, height, pngOut, items }) into ffmpeg pieces:
 *   inputs     — extra -i args (PNG overlay input on macOS, none on Linux)
 *   filterTail — filter step consuming [v2] and producing [vout]
 *   cleanup()  — removes temp drawtext text files
 * Both engines draw the same items at the same coordinates; AppKit measures
 * text top-left like drawtext's x/y, so layouts match.
 */
async function buildOverlay(spec) {
  if (process.platform === 'darwin' && !(await hasDrawtext())) {
    await renderOverlayPng({ width: spec.width, height: spec.height, out: spec.pngOut, items: spec.items })
    return { inputs: ['-i', spec.pngOut], filterTail: '[v2][2:v]overlay=0:0[vout]', cleanup: () => {} }
  }
  // drawtext engine — write each text to a file so no content escaping is needed
  const textFiles = []
  const steps = spec.items.map((it, i) => {
    const tf = `${spec.pngOut}.${i}.txt`
    writeFileSync(tf, it.text)
    textFiles.push(tf)
    const x = it.align === 'center' ? '(w-text_w)/2'
      : it.align === 'right' ? `${it.x}-text_w`
      : String(it.x)
    const alpha = it.alpha == null ? 1 : it.alpha
    const font = it.font === 'Arial-BoldMT' ? FONT_BOLD : FONT_REG
    return `drawtext=fontfile='${fesc(font)}':textfile='${fesc(tf)}':fontsize=${it.size}:fontcolor=white@${alpha}:x=${x}:y=${it.y}`
  })
  return {
    inputs: [],
    filterTail: `[v2]${steps.join(',')}[vout]`,
    cleanup: () => { for (const f of textFiles) { try { unlinkSync(f) } catch {} } }
  }
}

// Transient-tolerant fetch: fmcloud/S3 occasionally drop a connection mid-run.
async function fetchRetry(url, opts, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, opts)
    } catch (err) {
      if (i >= tries - 1) throw err
      await new Promise(r => setTimeout(r, 2000 * (i + 1)))
    }
  }
}

async function download(url, dest) {
  if (existsSync(dest)) return dest
  const res = await fetchRetry(url)
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

async function ffmpeg(argv) {
  try {
    await execFileP('ffmpeg', argv, { maxBuffer: 32 * 1024 * 1024 })
  } catch (err) {
    // ffmpeg reports everything on stderr — surface the tail, not the spam
    const tail = String(err.stderr || '').trim().split('\n').slice(-6).join('\n')
    throw new Error(`ffmpeg failed${tail ? `:\n${tail}` : `: ${err.message}`}`)
  }
}

function sidecar(t, file, kind) {
  // utm_* params let site analytics attribute visits to the channel — the
  // channel's stated goal is driving traffic to the site, so measure it.
  const shareUrl = `${SITE}/?t=${t.recordId}&utm_source=youtube&utm_medium=video&utm_content=${kind}`
  const lines = [
    `SUGGESTED TITLE:`,
    `${t.artist} – ${t.title}${t.year ? ` (${t.year})` : ''}${kind === 'short' ? ' #Shorts' : ''}`,
    ``,
    `DESCRIPTION:`,
    `${t.title} by ${t.artist}${t.album ? ` — from the album "${t.album}"` : ''}${t.year ? ` (${t.year})` : ''}.`,
    ``,
    `▶ Listen on MAD Music: ${shareUrl}`,
    `Stream African music — classics and new releases: ${SITE}`,
    ``,
    t.pLine || '',
    ``,
    `TAGS:`,
    [t.artist, t.title, t.genre, 'South African music', 'African music', 'MAD Music', t.year]
      .filter(Boolean).join(', ')
  ]
  writeFileSync(file, lines.join('\n'))
}

// ── renderers ────────────────────────────────────────────────────────────────
async function renderArtTrack(t, art, audio, out, { excerpt }) {
  const durationArgs = excerpt > 0 ? ['-t', String(excerpt)] : []
  const meta = [t.year, t.genre].filter(Boolean).join('   ·   ')
  const overlay = await buildOverlay({
    width: 1920, height: 1080, pngOut: out.replace(/\.mp4$/, '.overlay.png'),
    items: [
      { text: t.title, font: 'Arial-BoldMT', size: 66, x: 980, y: 380 },
      { text: t.artist, font: 'ArialMT', size: 46, alpha: 0.92, x: 980, y: 486 },
      ...(meta ? [{ text: meta, font: 'ArialMT', size: 32, alpha: 0.6, x: 980, y: 566 }] : []),
      { text: 'musicafricadirect.com', font: 'ArialMT', size: 30, alpha: 0.55, x: 1860, y: 56, align: 'right' }
    ]
  })
  const filter = [
    // ambient-blur background from the sleeve (never stretched art — blurred fill)
    `[1:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=40,eq=brightness=-0.25[bg]`,
    // sharp sleeve, left
    `[1:v]scale=760:760[sleeve]`,
    `[bg][sleeve]overlay=140:160[v1]`,
    // waveform strip along the bottom
    `[0:a]showwaves=s=1640x110:mode=cline:rate=25:colors=white@0.45[waves]`,
    `[v1][waves]overlay=140:930[v2]`,
    // text overlay (AppKit PNG on macOS, drawtext chain on Linux)
    overlay.filterTail
  ].join(';')

  try {
    await ffmpeg([
      '-y', '-i', audio, '-loop', '1', '-i', art, ...overlay.inputs,
      '-filter_complex', filter, '-map', '[vout]', '-map', '0:a',
      ...durationArgs, '-shortest',
      '-c:v', 'libx264', '-preset', X264_PRESET, '-tune', 'stillimage', '-crf', '19', '-r', '25', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', out
    ])
  } finally {
    overlay.cleanup()
  }
}

async function renderShort(t, art, audio, out, { shortLen, shortOffset }) {
  const overlay = await buildOverlay({
    width: 1080, height: 1920, pngOut: out.replace(/\.mp4$/, '.overlay.png'),
    items: [
      { text: t.title, font: 'Arial-BoldMT', size: 64, align: 'center', x: 0, y: 1260 },
      { text: t.artist, font: 'ArialMT', size: 46, alpha: 0.92, align: 'center', x: 0, y: 1364 },
      { text: 'Full track on musicafricadirect.com', font: 'ArialMT', size: 34, alpha: 0.65, align: 'center', x: 0, y: 1730 }
    ]
  })
  const filter = [
    `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=45,eq=brightness=-0.25[bg]`,
    `[1:v]scale=880:880[sleeve]`,
    `[bg][sleeve]overlay=100:290[v1]`,
    `[0:a]showwaves=s=880x100:mode=cline:rate=25:colors=white@0.45[waves]`,
    `[v1][waves]overlay=100:1560[v2]`,
    overlay.filterTail
  ].join(';')

  try {
    await ffmpeg([
      '-y', '-ss', String(shortOffset), '-i', audio, '-loop', '1', '-i', art, ...overlay.inputs,
      '-filter_complex', filter, '-map', '[vout]', '-map', '0:a',
      '-t', String(shortLen), '-shortest',
      '-af', `afade=t=in:d=0.8,afade=t=out:st=${shortLen - 1}:d=1`,
      '-c:v', 'libx264', '-preset', X264_PRESET, '-tune', 'stillimage', '-crf', '19', '-r', '25', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
      '-movflags', '+faststart', out
    ])
  } finally {
    overlay.cleanup()
  }
}

// ── main entry ───────────────────────────────────────────────────────────────
/**
 * Render art-tracks and/or Shorts for the given MadStreamer record IDs.
 * `trackIds`/`shortIds` are arrays of recordId strings (a record may be in
 * both). Calls `log`/`warn` as it goes; returns a summary the route can emit.
 */
export async function generateVideos({
  trackIds = [],
  shortIds = [],
  outDir = DEFAULT_OUT_DIR,
  excerpt = 0,          // 0 = full track
  shortLen = 30,
  shortOffset = 30,
  metaOnly = false,
  log = () => {},
  warn = () => {},
} = {}) {
  const all = [...new Set([...trackIds, ...shortIds])]
  if (!all.length) throw Object.assign(new Error('No tracks selected'), { status: 400 })

  if (!metaOnly) {
    const support = await checkRenderSupport()
    if (!support.ok) throw Object.assign(new Error(support.problems.join(' ')), { status: 501 })
  }

  mkdirSync(outDir, { recursive: true })

  // Say exactly what was queued — catches "ticked the wrong column" instantly
  log(`Queued: ${trackIds.length} art-track(s), ${shortIds.length} Short(s)${metaOnly ? ' (sidecars only)' : ''}`)

  const done = [], skipped = [], failed = []
  for (const rid of all) {
    try {
      const t = await getSongForVideo(rid)
      if (!t || !t.audioUrl || !t.artUrl) {
        warn(`SKIP ${rid}: ${!t ? 'record not found' : !t.audioUrl ? 'no audio (S3_URL empty)' : 'no artwork (Artwork_S3_URL empty)'}`)
        skipped.push(rid)
        continue
      }
      const base = `${slug(t.artist)}--${slug(t.title)}`
      log(`${t.artist} – ${t.title} (${t.year || '?'})`)

      if (metaOnly) {
        if (trackIds.includes(rid)) sidecar(t, join(outDir, `${base}--arttrack.txt`), 'arttrack')
        if (shortIds.includes(rid)) sidecar(t, join(outDir, `${base}--short.txt`), 'short')
        log(`  sidecars rewritten (meta-only)`)
        done.push({ recordId: rid, base, metaOnly: true })
        continue
      }

      log(`  downloading artwork + audio…`)
      const art = await download(t.artUrl, join(outDir, `${base}.art${t.artUrl.includes('.webp') ? '.webp' : '.jpg'}`))
      const audio = await download(t.audioUrl, join(outDir, `${base}.mp3`))

      const outputs = []
      if (trackIds.includes(rid)) {
        const out = join(outDir, `${base}--arttrack.mp4`)
        log(`  rendering art-track (this encodes the full track — can take a few minutes)…`)
        await renderArtTrack(t, art, audio, out, { excerpt })
        sidecar(t, join(outDir, `${base}--arttrack.txt`), 'arttrack')
        outputs.push(out)
        log(`  ✓ art-track → ${out}`)
      }
      if (shortIds.includes(rid)) {
        const out = join(outDir, `${base}--short.mp4`)
        log(`  rendering short…`)
        await renderShort(t, art, audio, out, { shortLen, shortOffset })
        sidecar(t, join(outDir, `${base}--short.txt`), 'short')
        outputs.push(out)
        log(`  ✓ short → ${out}`)
      }
      done.push({ recordId: rid, base, outputs })
    } catch (err) {
      warn(`FAILED ${rid}: ${err.message}`)
      failed.push(rid)
    }
  }

  log(`Done. ${done.length} rendered, ${skipped.length} skipped, ${failed.length} failed. Output: ${outDir}`)
  return { outDir, done, skipped, failed }
}
