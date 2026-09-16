#!/usr/bin/env python3
"""
MAD Sync Tagger
===============
Better mood/theme tags for the Gallo catalogue, aimed at music supervisors.

WHY THIS EXISTS
---------------
mad_analyzer.py derives a mood from three Essentia numbers (energy,
danceability, spectral complexity) through a hand-written rule. The rule is too
blunt: 57,008 of 67,263 tracks came out as "Happy / Energetic", which tells a
supervisor nothing. Essentia's own pretrained mood models would fix it, but the
build that runs them (essentia-tensorflow) has no Apple Silicon wheel.

So this uses CLAP (laion/clap-htsat-unfused), an audio/text model that scores a
recording against any phrase you give it. The phrases here are written the way
briefs are written — "melancholy, reflective", "upbeat township jive for a
celebration", "instrumental, leaves room for dialogue" — so the output is
searchable in the language buyers actually use.

SAFE BY DEFAULT
---------------
Writes a CSV and nothing else unless you pass --apply. Even with --apply it
writes to NEW FileMaker fields and never touches AI_Mood, so the existing tags
stay until you are satisfied. Resumable: a re-run skips tracks already in the
journal.

FIRST RUN
---------
    cd ~/Desktop/MAD-Analyzer
    ./venv/bin/pip install torch transformers soundfile
    ./venv/bin/python sync_tagger.py --limit 25          # CSV only, ~5 min
    open sync_tags.csv                                    # judge the tags
    ./venv/bin/python sync_tagger.py --apply              # the whole catalogue

FileMaker fields needed on the "Song Files" layout before --apply works
(FileMaker rejects the whole write if a field is missing):
    AI_Tags            text   the top tags, comma separated
    AI_Mood_v2         text   the single best mood
    AI_Theme           text   the best use/theme tag (film, advertising…)
    AI_Vocal           text   "Instrumental" or "Vocal"
    AI_Tag_Confidence  number 0–100 for the best mood
"""

import argparse
import csv
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mad_analyzer import FileMakerAPI, S3Downloader, load_config  # noqa: E402

log = logging.getLogger("sync_tagger")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout),
                              logging.FileHandler("sync_tagger.log")])

MODEL_ID = "laion/clap-htsat-unfused"
SAMPLE_RATE = 48000          # what CLAP expects
WINDOW_SECONDS = 10
WINDOWS_AT = (0.15, 0.45, 0.75)   # three places in the track, averaged

# ── The vocabulary ───────────────────────────────────────────────────────────
# Each entry is (tag, prompt). The tag is what gets stored; the prompt is what
# the model is asked. Prompts are full sentences because CLAP was trained on
# captions, not keywords — "happy" alone scores badly, "a happy, upbeat song
# with a cheerful feel" scores well.
MOODS = [
    ("Joyful",       "a happy, upbeat, cheerful song full of celebration"),
    ("Melancholic",  "a sad, mournful, melancholy song full of longing"),
    ("Tender",       "a gentle, tender, affectionate love song"),
    ("Calm",         "a calm, peaceful, relaxing piece of music"),
    ("Hypnotic",     "a hypnotic, repetitive, trance-like groove"),
    ("Defiant",      "a defiant, proud, determined protest song"),
    ("Spiritual",    "a devotional, spiritual, worshipful gospel piece"),
    ("Nostalgic",    "a nostalgic, wistful song that sounds like an old memory"),
    ("Playful",      "a playful, humorous, light-hearted tune"),
    ("Dramatic",     "dramatic, intense, cinematic music building tension"),
    ("Lonely",       "a lonely, sparse, desolate piece of music"),
    ("Triumphant",   "a triumphant, victorious, uplifting anthem"),
    ("Sensual",      "a slow, smooth, sensual groove"),
    ("Restless",     "a restless, urgent, driving rhythm"),
    ("Solemn",       "solemn, dignified, ceremonial music"),
]
THEMES = [
    ("Film",         "music suitable for a film score or a dramatic scene"),
    ("Advertising",  "music suitable for a television advertisement"),
    ("Documentary",  "music suitable for a documentary about history"),
    ("Trailer",      "music suitable for a trailer, big and attention-grabbing"),
    ("Sport",        "energetic music suitable for a sports montage"),
    ("Party",        "music for a party, a dance floor, a crowd"),
    ("Funeral",      "music for a funeral, a memorial, a moment of mourning"),
    ("Wedding",      "music for a wedding or a celebration of love"),
    ("Street",       "music that sounds like a busy street or a township scene"),
    ("Rural",        "music that evokes the countryside, farmland, open land"),
    ("Opening",      "music for an opening title sequence"),
    ("Closing",      "reflective music for closing credits"),
]
VOCAL = [
    ("Instrumental", "an instrumental piece with no singing, only instruments"),
    ("Vocal",        "a song with a lead singer and lyrics"),
    ("Choir",        "a song sung by a large group or choir in harmony"),
    ("Spoken",       "a recording with spoken word or narration over music"),
]
TEXTURE = [
    ("Acoustic",     "an acoustic recording with live instruments in a room"),
    ("Electric",     "a recording driven by electric guitar and organ"),
    ("Brass",        "a recording featuring brass, horns, saxophone"),
    ("Accordion",    "a recording featuring accordion or concertina"),
    ("Percussive",   "a recording dominated by drums and percussion"),
    ("Strings",      "a recording featuring strings or orchestral instruments"),
    ("Sparse",       "a sparse arrangement with only one or two instruments"),
    ("Lo-fi",        "an old recording with tape hiss and limited fidelity"),
]
# South African scenes. The generic vocabulary above could describe music from
# anywhere; these are the words a local brief actually uses — "township street,
# 1950s", "shebeen", "freedom song" — and they are the reason someone would
# search this catalogue rather than a stock library. Ian's list; extend it
# freely, the prompts are just sentences.
SCENES = [
    ("Kwela street",      "penny whistle kwela played on a street corner in 1950s Johannesburg"),
    ("Shebeen",           "lively music in a crowded shebeen, drinking and dancing"),
    ("Marabi piano",      "marabi piano and organ vamp at a 1940s South African house party"),
    ("Sophiatown jazz",   "1950s South African big band jazz with horn section"),
    ("Cape goema",        "Cape Town goema carnival rhythm with brass and banjo"),
    ("Mbaqanga groove",   "mbaqanga groove with electric guitar, walking bass and groaning bass voice"),
    ("Maskandi guitar",   "maskandi Zulu guitar picking with spoken praise poetry"),
    ("Isicathamiya",      "soft-stepping Zulu male choral harmony sung without instruments"),
    ("Mine dance",        "rhythmic stamping mine dance with whistles and shouted calls"),
    ("Township jive",     "fast township jive with saxophone and driving drums"),
    ("Bubblegum 80s",     "1980s South African bubblegum pop with synthesizers and drum machine"),
    ("Kwaito street",     "slow heavy kwaito beat with spoken Zulu vocals, 1990s Johannesburg"),
    ("Amapiano lounge",   "amapiano with log drum bass, shakers and airy keys"),
    ("Church hall",       "South African church congregation singing gospel with organ"),
    ("Freedom song",      "a South African freedom song sung by a marching crowd"),
    ("Ancestral ceremony","traditional African ceremonial drumming, chanting and rattles"),
    ("Ululation",         "African celebration with ululation, clapping and singing"),
    ("Bushveld",          "music evoking the African bushveld, open grassland and distant horizon"),
    ("Karoo",             "sparse lonely music evoking a dry Karoo landscape"),
    ("Boeremusiek dance", "Afrikaans boeremusiek with concertina and accordion for a barn dance"),
    ("Stadium crowd",     "a stadium crowd singing together with vuvuzelas"),
    ("Mission hymn",      "a slow mission hymn sung in harmony at a funeral"),
]

GROUPS = [("mood", MOODS), ("theme", THEMES), ("vocal", VOCAL), ("texture", TEXTURE), ("scene", SCENES)]

JOURNAL = Path("sync_tags_journal.jsonl")
CSV_PATH = Path("sync_tags.csv")


def decode_excerpts(path):
    """Three 10-second windows, mono 48 kHz, as one averaged batch of floats."""
    dur = _duration(path)
    if not dur:
        return None
    outs = []
    for frac in WINDOWS_AT:
        start = max(0.0, min(dur - WINDOW_SECONDS, dur * frac))
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-ss", f"{start:.2f}", "-t", str(WINDOW_SECONDS),
             "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"],
            capture_output=True).stdout
        if raw:
            outs.append(np.frombuffer(raw, dtype=np.float32))
    return outs or None


def _duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return None


def _vec(out):
    """transformers 5 returns an output object here, 4.x returned the tensor."""
    if hasattr(out, "pooler_output") and out.pooler_output is not None:
        return out.pooler_output
    for attr in ("text_embeds", "audio_embeds", "last_hidden_state"):
        v = getattr(out, attr, None)
        if v is not None:
            return v if v.dim() == 2 else v.mean(dim=1)
    return out


class Tagger:
    """CLAP, loaded once. Text prompts are embedded once and reused."""

    def __init__(self):
        import torch
        from transformers import ClapModel, ClapProcessor
        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        log.info(f"loading {MODEL_ID} on {self.device} (first run downloads ~600 MB)")
        self.model = ClapModel.from_pretrained(MODEL_ID).to(self.device).eval()
        self.proc = ClapProcessor.from_pretrained(MODEL_ID)
        prompts = [p for _, group in GROUPS for _, p in group]
        with torch.no_grad():
            inputs = self.proc(text=prompts, return_tensors="pt", padding=True).to(self.device)
            emb = _vec(self.model.get_text_features(**inputs))
            self.text = emb / emb.norm(dim=-1, keepdim=True)

    def tag(self, excerpts):
        torch = self.torch
        with torch.no_grad():
            inputs = self.proc(audio=excerpts, sampling_rate=SAMPLE_RATE, return_tensors="pt").to(self.device)
            emb = _vec(self.model.get_audio_features(**inputs))
            emb = (emb / emb.norm(dim=-1, keepdim=True)).mean(dim=0, keepdim=True)
            scores = (emb @ self.text.T).squeeze(0).cpu().numpy()

        out, at = {}, 0
        for name, group in GROUPS:
            n = len(group)
            part = scores[at:at + n]
            at += n
            # Softmax WITHIN each group: the question is "which mood", not
            # "is this more of a mood than a texture".
            ex = np.exp((part - part.max()) * 20)
            probs = ex / ex.sum()
            ranked = sorted(zip([t for t, _ in group], probs), key=lambda x: -x[1])
            out[name] = ranked
        return out


def summarise(ranked):
    """The stored shape: a best mood, a theme, vocal/instrumental, and a tag list."""
    mood, mood_p = ranked["mood"][0]
    theme = ranked["theme"][0][0]
    vocal = ranked["vocal"][0][0]
    # The South African scene leads the tag list: it is the most specific thing
    # said about the track and the phrase a local brief starts from.
    scenes = [t for t, p in ranked.get("scene", [])[:2] if p > 0.12]
    tags = scenes + [mood, theme, vocal]
    tags += [t for t, p in ranked["texture"][:2] if p > 0.20]
    tags += [t for t, p in ranked["mood"][1:3] if p > 0.15]
    seen, uniq = set(), []
    for t in tags:
        if t.lower() not in seen:
            seen.add(t.lower())
            uniq.append(t)
    return {"mood": mood, "confidence": round(float(mood_p) * 100, 1),
            "theme": theme, "vocal": vocal, "scene": (scenes[0] if scenes else ""),
            "tags": ", ".join(uniq)}


def load_done():
    done = {}
    if JOURNAL.exists():
        for line in JOURNAL.read_text().splitlines():
            try:
                row = json.loads(line)
                done[row["filename"]] = row
            except Exception:
                pass
    return done


def main():
    ap = argparse.ArgumentParser(description="Sync-oriented mood/theme tags for the catalogue")
    ap.add_argument("--limit", type=int, default=0, help="stop after N tracks (0 = all)")
    ap.add_argument("--apply", action="store_true", help="write to FileMaker (new fields only)")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--worklist", help="file of Filenames, one per line — tag these instead of "
                                       "walking FileMaker (CSV only; no record ids to write back to)")
    args = ap.parse_args()

    cfg = load_config(args.config)
    fm_fields = {  # new fields only — AI_Mood is deliberately left alone
        "tags": "AI_Tags", "mood": "AI_Mood_v2", "theme": "AI_Theme",
        "vocal": "AI_Vocal", "confidence": "AI_Tag_Confidence",
    }

    fm = FileMakerAPI(cfg)
    fm.login()
    try:
        if args.worklist:
            names = [l.strip() for l in Path(args.worklist).read_text().splitlines() if l.strip()]
            done = load_done()
            todo = [(None, n) for n in names if n not in done]
            if args.limit:
                todo = todo[: args.limit]
            log.info(f"{len(todo)} from worklist{' (CSV only — no FileMaker record ids)' if args.apply else ''}")
            args.apply = False
        else:
            # Take records lazily: a --limit run should not page through all
            # 67,280 records (2-3 minutes) before tagging its first track.
            done = load_done()
            todo = []
            for record_id, filename in fm.get_all_records(cfg["filemaker"]["filename_field"]):
                if not filename or filename in done:
                    continue
                todo.append((record_id, filename))
                if args.limit and len(todo) >= args.limit:
                    break
        log.info(f"{len(todo)} to tag ({len(done)} already done){'' if args.apply else ' — CSV only, no writes'}")
        if not todo:
            return

        s3 = S3Downloader(cfg)
        tagger = Tagger()
        new_csv = not CSV_PATH.exists()
        started, ok, failed = time.time(), 0, 0

        with CSV_PATH.open("a", newline="") as fh:
            writer = csv.writer(fh)
            if new_csv:
                writer.writerow(["filename", "scene", "mood", "confidence", "theme", "vocal", "tags"])

            for i, (record_id, filename) in enumerate(todo, 1):
                with tempfile.TemporaryDirectory() as tmp:
                    # The bucket keys carry the extension (mp3/GMVF43935.mp3);
                    # FileMaker's Filename does not.
                    key_name = filename if filename.lower().endswith(".mp3") else f"{filename}.mp3"
                    local = Path(tmp) / key_name
                    try:
                        s3.download(key_name, str(local))
                        excerpts = decode_excerpts(local)
                        if not excerpts:
                            raise RuntimeError("could not decode audio")
                        result = summarise(tagger.tag(excerpts))
                    except Exception as e:
                        failed += 1
                        log.warning(f"  {filename}: {e}")
                        continue

                writer.writerow([filename, result["scene"], result["mood"], result["confidence"],
                                 result["theme"], result["vocal"], result["tags"]])
                fh.flush()
                with JOURNAL.open("a") as j:
                    j.write(json.dumps({"filename": filename, **result}) + "\n")

                if args.apply and record_id:
                    try:
                        fm.update_record(record_id, {fm_fields[k]: str(result[k]) for k in fm_fields})
                    except Exception as e:
                        log.warning(f"  {filename}: FileMaker write failed: {e}")

                ok += 1
                if i % 20 == 0:
                    rate = (time.time() - started) / i
                    left = (len(todo) - i) * rate / 60
                    log.info(f"{i}/{len(todo)} · {rate:.1f}s/track · ~{left:.0f} min left · {failed} failed")

        log.info(f"done: {ok} tagged, {failed} failed → {CSV_PATH}")
    finally:
        fm.logout()


if __name__ == "__main__":
    main()
