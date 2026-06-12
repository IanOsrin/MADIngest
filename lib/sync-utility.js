/**
 * lib/sync-utility.js
 * Daily sync: pulls files from S3 AudioImports/ to Vision drive, then deletes from S3.
 *
 * Run manually:  node lib/sync-utility.js
 * Cron (daily):  0 2 * * * cd /path/to/GalloIngest && node lib/sync-utility.js >> logs/sync.log 2>&1
 *
 * Env required:
 *   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   S3_IMPORTS_BUCKET, S3_IMPORTS_PREFIX
 *   VISION_PATH  — local path to the Vision drive
 */

import 'dotenv/config'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'
import { listImports, downloadImport, deleteImport } from './s3-imports.js'

const VISION_PATH = (process.env.VISION_PATH || '/Volumes/vision/GalloImports').trim()
const DRY_RUN     = process.argv.includes('--dry-run')

async function run() {
  console.log(`[Sync] Starting — ${new Date().toISOString()}`)
  console.log(`[Sync] Vision path: "${VISION_PATH}"`)
  if (DRY_RUN) console.log('[Sync] DRY RUN — no files will be downloaded or deleted')

  // Ensure destination directory exists
  if (!DRY_RUN) {
    try {
      await mkdir(VISION_PATH, { recursive: true })
    } catch(err) {
      console.error(`[Sync] ERROR — Cannot create destination: ${err.message}`)
      process.exit(1)
    }
  }

  // List files in S3
  const items = await listImports()
  console.log(`[Sync] Found ${items.length} file(s) in S3 AudioImports/`)

  if (!items.length) {
    console.log('[Sync] Nothing to sync — exiting')
    return
  }

  let synced = 0, failed = 0

  for (const item of items) {
    const filename  = path.basename(item.key)
    const localPath = path.join(VISION_PATH, filename)
    const sizeMB    = (item.size / 1024 / 1024).toFixed(1)

    console.log(`[Sync] → ${filename} (${sizeMB} MB)`)

    if (DRY_RUN) { synced++; continue }

    try {
      const buffer = await downloadImport(item.key)
      await writeFile(localPath, buffer)
      console.log(`[Sync]   ✓ Saved to ${localPath}`)

      // Delete from S3 only after confirmed write
      await deleteImport(item.key)
      console.log(`[Sync]   ✓ Deleted from S3`)
      synced++
    } catch(err) {
      console.error(`[Sync]   ✗ Failed: ${err.message}`)
      failed++
    }
  }

  console.log(`[Sync] Complete — ${synced} synced, ${failed} failed — ${new Date().toISOString()}`)
}

run().catch(err => {
  console.error('[Sync] Fatal:', err.message)
  process.exit(1)
})
