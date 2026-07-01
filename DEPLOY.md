# Deploying GalloIngest to Render

## 1. Push to GitHub

```bash
cd ~/Desktop/GalloIngestV1.1
gh repo create gallo-ingest --private --source . --push
# or manually:
# git remote add origin git@github.com:YOUR_USER/gallo-ingest.git
# git push -u origin main
```

Note: `Gallo_Metadata_Extract.xlsx` (~65 MB) is intentionally in the repo — the app
loads it into memory at boot. GitHub will warn about size but accept it.

## 2. Create the service on Render

1. Render Dashboard → **New → Blueprint**, connect the GitHub repo.
   Render reads `render.yaml` (Docker runtime, Frankfurt, `/health` check).
2. When prompted, fill in the secret env vars (values from your local `.env`):

| Variable | Notes |
|---|---|
| `INGEST_ADMIN_SECRET` | admin auth |
| `GALLO_FM_HOST` | `https://digitalcupboard.app` |
| `GALLO_FM_DB` / `GALLO_FM_USER` / `GALLO_FM_PASS` | FileMaker Data API creds |
| `GALLO_FM_LAYOUT` / `GALLO_FM_TAPE_LAYOUT` | layouts |
| `MADSTREAMER_FM_HOST` / `MADSTREAMER_FM_DB` | fmcloud host |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 uploads (eu-north-1) |
| `FM_SERVER_ASSET_PATH` | FM server-side asset path string |

Already set by the blueprint: `NODE_ENV=production`, `UPLOAD_TMP_DIR=/tmp/gallo-uploads`,
`AWS_REGION=eu-north-1`. `PORT` is injected by Render automatically. `VISION_PATH` is
not needed — the Vision sync utility only runs locally.

## 3. Things to know

- **Plan**: blueprint specifies `standard` (2 GB RAM). The metadata xlsx parses into
  memory; 512 MB plans will likely OOM.
- **Ephemeral disk**: `data/submissions.json` and `/tmp` uploads reset on every
  deploy/restart. FileMaker + S3 remain the source of truth.
- **Updating the metadata extract**: commit a new `Gallo_Metadata_Extract.xlsx` and
  push — auto-deploy rebuilds with it. (Or set `METADATA_FILE` to an S3-fetched path
  later if the repo gets too heavy.)
- **ffmpeg** is baked into the Docker image; no `FFMPEG_BIN` needed.
- After deploy, check `https://YOUR-SERVICE.onrender.com/health` → `{"ok":true}`,
  then `/ingest/admin`.
