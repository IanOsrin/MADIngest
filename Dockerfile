FROM node:22-slim

# ffmpeg required by lib/audio-convert.js (WAV → MP3)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
# Render injects PORT; server.js falls back to 3001 locally
EXPOSE 3001

CMD ["node", "server.js"]
