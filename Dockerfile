# Stage 1: install deps + convert the metadata xlsx to JSON.
# The xlsx parse needs ~500MB RAM, so it happens here (build machines are
# big) instead of at runtime (512MB starter plan).
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN node scripts/convert-metadata.js Gallo_Metadata_Extract.xlsx data/metadata.json \
  && rm Gallo_Metadata_Extract.xlsx

# Stage 2: runtime image with ffmpeg (lib/audio-convert.js shells out to it;
# lib/youtube-video.js also needs its drawtext filter + Liberation fonts for
# video text overlays — Debian ffmpeg has drawtext, unlike Homebrew's)
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-liberation fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

# Generated covers (Make Cover tab) are designed with macOS fonts; here each of those names is pointed at a free
# look-alike bundled in fonts/cover-fonts (see gallo-covers.conf there); DejaVu supplies the ✝ and ✦ ornaments.
RUN cp /app/fonts/cover-fonts/gallo-covers.conf /etc/fonts/conf.d/60-gallo-covers.conf && fc-cache -f

ENV NODE_ENV=production
ENV METADATA_FILE=/app/data/metadata.json
# Node sizes its own heap conservatively, so it is set here. 400MB suited the
# old 512MB starter plan; on standard (2GB, render.yaml) it was still 400 and a
# MAM Health refresh on top of the metadata cache and the Vision index hit
# "Reached heap limit" and restarted the service (2026-10-20). 1400MB leaves
# ~600MB for the process itself and for ffmpeg, which runs as a child.
ENV NODE_OPTIONS=--max-old-space-size=1400
# Render injects PORT; server.js falls back to 3001 locally
EXPOSE 3001

CMD ["node", "server.js"]
