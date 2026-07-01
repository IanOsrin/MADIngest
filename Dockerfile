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

# Stage 2: runtime image with ffmpeg (lib/audio-convert.js shells out to it)
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app .

ENV NODE_ENV=production
ENV METADATA_FILE=/app/data/metadata.json
# Render injects PORT; server.js falls back to 3001 locally
EXPOSE 3001

CMD ["node", "server.js"]
