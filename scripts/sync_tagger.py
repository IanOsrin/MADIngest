#!/usr/bin/env python3
"""
MAD Sync Tagger — version 2 (16 September 2026)
===============================================
Mood and vocal tags for the Gallo catalogue, aimed at music supervisors.

WHY THIS EXISTS
---------------
mad_analyzer.py derives a mood from three Essentia numbers through a
hand-written rule. It called 57,008 of 67,263 tracks "Happy / Energetic", which
tells a supervisor nothing. Essentia's pretrained mood models have no Apple
Silicon build, so this uses CLAP (laion/clap-htsat-unfused), an audio/text model
that scores a recording against written phrases.

WHAT CHANGED IN VERSION 2 (after checking all 131 Marabi and 634 Kwaito tracks)
------------------------------------------------------------------------------
- Scene comes from the track's GENRE, not the model. The model's scene phrases
  landed "Sophiatown jazz" and "Cape goema" on 1980s bubblegum; the genre field
  is simply more reliable. Genres with no clear scene get none.
- Texture tags are gone (Brass was on 127 of 131 Marabi and 202 of 250 Kwaito
  tracks — kwaito is synths and drum machines). They misled searches.
- Theme is gone. It was mostly "Wedding" when nothing fitted. AI_Theme is no
  longer written, so anything set by hand in the Tags tab stays.
- Vocal respects the Language field: a track whose language is isiZulu, English,
  Sesotho… cannot be "Instrumental" (27 Marabi tracks were). "Spoken" needs a
  strong score (it was on 18 Marabi tracks).
- A second mood is added to the tag list when it scores close to the first, and
  every track's full mood scores go into the journal.
- --rebalance re-picks moods WITHIN a genre, so one mood cannot swallow a genre
  (Hypnotic was on 201 of 250 Kwaito tracks). Runs from the journal, no audio.
- Records corrected by hand in the Tags tab (confidence 100) are never touched.

SAFE BY DEFAULT
---------------
Writes a CSV and a journal and nothing else unless you pass --apply. With
--apply it writes only AI_Tags, AI_Mood_v2, AI_Vocal and AI_Tag_Confidence on the
"Song Files" layout; AI_Mood, AI_BPM, AI_Key, AI_Energy and AI_Theme are never
touched. Resumable: tracks already in the journal are skipped unless --retag.

USAGE
-----
    cd ~/Desktop/MAD-Analyzer
    ./venv-sync/bin/python sync_tagger.py --genre Marabi --limit 20          # CSV only
    caffeinate -i ./venv-sync/bin/python sync_tagger.py --genre Marabi,Kwaito --retag --apply
    ./venv-sync/bin/python sync_tagger.py --rebalance --genre Kwaito --apply # no audio needed
    caffeinate -i ./venv-sync/bin/python sync_tagger.py --apply              # everything
"""

import argparse
import csv
import json
import logging
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from mad_analyzer import FileMakerAPI, S3Downloader, load_config  # noqa: E402

log = logging.getLogger("sync_tagger")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
                    handlers=[logging.StreamHandler(sys.stdout),
                              logging.FileHandler("sync_tagger.log")])

VERSION = 2
MODEL_ID = "laion/clap-htsat-unfused"
SAMPLE_RATE = 48000          # what CLAP expects
WINDOW_SECONDS = 10
WINDOWS_AT = (0.15, 0.45, 0.75)   # three places in the track, averaged

# ── The vocabulary ───────────────────────────────────────────────────────────
# (tag, prompt). The tag is stored; the prompt is what the model is asked. CLAP
# was trained on captions, so prompts are full sentences.
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
VOCAL = [
    ("Instrumental", "an instrumental piece with no singing, only instruments"),
    ("Vocal",        "a song with a lead singer and lyrics"),
    ("Choir",        "a song sung by a large group or choir in harmony"),
    ("Spoken",       "a recording with spoken word or narration over music"),
]
GROUPS = [("mood", MOODS), ("vocal", VOCAL)]

# Scene from the catalogue's Local Genre. Names must match TAG_VOCAB.scene in
# GalloIngest routes/tags.js. A genre not listed gets no scene rather than a guess.
GENRE_SCENE = {
    "marabi": "Marabi piano",
    "kwaito": "Kwaito street",
    "kwela": "Kwela street",
    "mbaqanga": "Mbaqanga groove",
    "maskandi": "Maskandi guitar",
    "isicathamiya": "Isicathamiya",
    "township jive": "Township jive",
    "bubblegum": "Bubblegum 80s",
    "amapiano": "Amapiano lounge",
    "gospel": "Church hall",
    "boere musiek": "Boeremusiek dance",
    "volksmusiek": "Boeremusiek dance",
    "cape jazz": "Cape goema",
}


def scene_for(genre, year):
    g = (genre or "").strip().lower()
    if g in GENRE_SCENE:
        return GENRE_SCENE[g]
    # Jazz is only "Sophiatown jazz" in its era; later jazz gets no scene.
    if g == "jazz" and str(year or "")[:4].isdigit() and 1945 <= int(str(year)[:4]) <= 1969:
        return "Sophiatown jazz"
    return ""


# Language values that mean "no words". Blank means unknown, not instrumental.
NO_LYRICS = {"zxx", "instrumental", "no linguistic content"}


def language_says(language):
    """'sung' when the Language field names a real language, 'none' when it says
    there are no lyrics, '' when blank or unknown."""
    lang = (language or "").strip().lower()
    if not lang:
        return ""
    return "none" if lang in NO_LYRICS else "sung"


JOURNAL = Path("sync_tags_journal.jsonl")
CSV_PATH = Path("sync_tags_v2.csv")   # new columns, so a new file
CSV_HEADER = ["filename", "genre", "scene", "mood", "mood2", "confidence", "vocal", "tags"]
FM_FIELDS = {"tags": "AI_Tags", "mood": "AI_Mood_v2", "vocal": "AI_Vocal", "confidence": "AI_Tag_Confidence"}
HAND_CHECKED = 100   # the Tags tab stores corrections at 100% confidence


def decode_excerpts(path):
    """Three 10-second windows, mono 48 kHz."""
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

    def scores(self, excerpts):
        """{"mood": {tag: prob}, "vocal": {tag: prob}} — softmax within each group."""
        torch = self.torch
        with torch.no_grad():
            inputs = self.proc(audio=excerpts, sampling_rate=SAMPLE_RATE, return_tensors="pt").to(self.device)
            emb = _vec(self.model.get_audio_features(**inputs))
            emb = (emb / emb.norm(dim=-1, keepdim=True)).mean(dim=0, keepdim=True)
            sims = (emb @ self.text.T).squeeze(0).cpu().numpy()
        out, at = {}, 0
        for name, group in GROUPS:
            part = sims[at:at + len(group)]
            at += len(group)
            ex = np.exp((part - part.max()) * 20)
            probs = ex / ex.sum()
            out[name] = {t: round(float(p), 4) for (t, _), p in zip(group, probs)}
        return out


def pick_vocal(vocal_probs, language):
    ranked = sorted(vocal_probs.items(), key=lambda x: -x[1])
    says = language_says(language)
    if says == "none":
        return "Instrumental"
    choice = ranked[0][0]
    if says == "sung" and choice == "Instrumental":
        # The catalogue says there are words; take the best singing option.
        choice = next(t for t, _ in ranked if t != "Instrumental")
    if choice == "Spoken" and vocal_probs["Spoken"] < 0.6:
        alt = next(t for t, _ in ranked if t not in ("Spoken",) and not (says == "sung" and t == "Instrumental"))
        choice = alt
    return choice


def summarise(mood_probs, vocal, scene, mood=None):
    """The stored shape. `mood` overrides the top-scoring mood (used by --rebalance)."""
    ranked = sorted(mood_probs.items(), key=lambda x: -x[1])
    best = mood or ranked[0][0]
    best_p = mood_probs[best]
    second = next((t for t, p in ranked if t != best and p >= 0.7 * best_p), "")
    tags = [t for t in (scene, best, second, vocal) if t]
    return {"mood": best, "mood2": second, "confidence": round(best_p * 100, 1),
            "vocal": vocal, "scene": scene, "tags": ", ".join(dict.fromkeys(tags))}


def load_journal():
    """Latest entry per filename."""
    done = {}
    if JOURNAL.exists():
        for line in JOURNAL.read_text().splitlines():
            try:
                row = json.loads(line)
                done[row["filename"]] = row
            except Exception:
                pass
    return done


# ── FileMaker record sources ────────────────────────────────────────────────
def _row(rec, filename_field):
    f = rec["fieldData"]
    return {"record_id": rec["recordId"], "filename": (f.get(filename_field) or "").strip(),
            "genre": (f.get("Local Genre") or "").strip(), "language": f.get("Language") or "",
            "year": f.get("Year of Release") or "", "confidence": f.get("AI_Tag_Confidence")}


def records_for_genre(fm, genre, filename_field):
    """Per-genre find, 500 at a time. A genre, never a whole-table scan."""
    offset = 1
    while True:
        r = fm.session.post(f"{fm.base}/layouts/{fm.layout}/_find",
                            json={"query": [{"Local Genre": f"=={genre}"}], "limit": 500, "offset": offset})
        body = r.json()
        code = (body.get("messages") or [{}])[0].get("code")
        if code == "401":          # no records match
            return
        r.raise_for_status()
        data = body["response"]["data"]
        for rec in data:
            yield _row(rec, filename_field)
        found = body["response"]["dataInfo"]["foundCount"]
        offset += len(data)
        if not data or offset > found:
            return


def all_records(fm, filename_field):
    offset = 1
    while True:
        records, total = fm.get_records(offset=offset, limit=100)
        if not records:
            return
        for rec in records:
            yield _row(rec, filename_field)
        offset += len(records)
        if offset > total:
            return


def is_hand_checked(row):
    try:
        return float(row.get("confidence") or 0) >= HAND_CHECKED
    except (TypeError, ValueError):
        return False


def write_fm(fm, record_id, result):
    fm.update_record(record_id, {FM_FIELDS[k]: str(result[k]) for k in FM_FIELDS})


# ── Tagging run ─────────────────────────────────────────────────────────────
def run_tagging(args, cfg, fm):
    fname_field = cfg["filemaker"]["filename_field"]
    journal = load_journal()
    genres = [g.strip() for g in (args.genre or "").split(",") if g.strip()]

    def source():
        if genres:
            for g in genres:
                yield from records_for_genre(fm, g, fname_field)
        else:
            yield from all_records(fm, fname_field)

    todo, skipped_hand = [], 0
    for row in source():
        if not row["filename"]:
            continue
        if is_hand_checked(row):
            skipped_hand += 1
            continue
        prev = journal.get(row["filename"])
        if prev and prev.get("v") == VERSION and not args.retag:
            continue
        todo.append(row)
        if args.limit and len(todo) >= args.limit:
            break
    log.info(f"{len(todo)} to tag · {skipped_hand} hand-checked left alone"
             f"{'' if args.apply else ' · CSV only, no FileMaker writes'}")
    if not todo:
        return

    s3 = S3Downloader(cfg)
    tagger = Tagger()
    new_csv = not CSV_PATH.exists()
    started, ok, failed = time.time(), 0, 0
    with CSV_PATH.open("a", newline="") as fh:
        writer = csv.writer(fh)
        if new_csv:
            writer.writerow(CSV_HEADER)
        for i, row in enumerate(todo, 1):
            filename = row["filename"]
            with tempfile.TemporaryDirectory() as tmp:
                key_name = filename if filename.lower().endswith(".mp3") else f"{filename}.mp3"
                local = Path(tmp) / key_name
                try:
                    s3.download(key_name, str(local))
                    excerpts = decode_excerpts(local)
                    if not excerpts:
                        raise RuntimeError("could not decode audio")
                    probs = tagger.scores(excerpts)
                except Exception as e:
                    failed += 1
                    log.warning(f"  {filename}: {e}")
                    continue

            vocal = pick_vocal(probs["vocal"], row["language"])
            result = summarise(probs["mood"], vocal, scene_for(row["genre"], row["year"]))
            writer.writerow([filename, row["genre"]] + [result[k] for k in CSV_HEADER[2:]])
            fh.flush()
            with JOURNAL.open("a") as j:
                j.write(json.dumps({"v": VERSION, "filename": filename, "record_id": row["record_id"],
                                    "genre": row["genre"], "language": row["language"], "year": row["year"],
                                    "moods": probs["mood"], "vocals": probs["vocal"], **result}) + "\n")
            if args.apply:
                try:
                    write_fm(fm, row["record_id"], result)
                except Exception as e:
                    log.warning(f"  {filename}: FileMaker write failed: {e}")
            ok += 1
            if i % 20 == 0:
                rate = (time.time() - started) / i
                log.info(f"{i}/{len(todo)} · {rate:.1f}s/track · ~{(len(todo) - i) * rate / 60:.0f} min left · {failed} failed")
    log.info(f"done: {ok} tagged, {failed} failed → {CSV_PATH}")


# ── Rebalance moods within a genre (no audio) ───────────────────────────────
def run_rebalance(args, cfg, fm):
    """Pick each track's mood by how much MORE it scores than the genre's average,
    so the genre's common flavour (e.g. Hypnotic for kwaito) no longer wins every
    track. Only tracks tagged by version 2 have the scores needed."""
    genres = {g.strip().lower() for g in (args.genre or "").split(",") if g.strip()}
    if not genres:
        sys.exit("--rebalance needs --genre (one or more, comma separated)")
    rows = [r for r in load_journal().values()
            if r.get("v") == VERSION and r.get("genre", "").lower() in genres and r.get("moods")]
    by_genre = defaultdict(list)
    for r in rows:
        by_genre[r["genre"].lower()].append(r)

    # Hand-checked records are refreshed from FileMaker so a correction made in the
    # Tags tab since tagging is never overwritten.
    hand = set()
    if args.apply:
        for g in genres:
            for row in records_for_genre(fm, g, cfg["filemaker"]["filename_field"]):
                if is_hand_checked(row):
                    hand.add(row["filename"])

    for g, items in by_genre.items():
        if len(items) < 30:
            log.info(f"{g}: only {len(items)} version-2 tracks — too few to rebalance, skipped")
            continue
        tags = list(items[0]["moods"].keys())
        mean = {t: float(np.mean([it["moods"][t] for it in items])) for t in tags}
        before, after, changed = defaultdict(int), defaultdict(int), 0
        for it in items:
            m = it["moods"]
            # Candidates: the track's own top four, so a mood it barely registers
            # can never be chosen just for being rare in the genre.
            top4 = sorted(m, key=lambda t: -m[t])[:4]
            pick = max(top4, key=lambda t: m[t] / max(mean[t], 1e-6))
            before[it["mood"]] += 1
            after[pick] += 1
            if pick == it["mood"] or it["filename"] in hand:
                continue
            result = summarise(m, it["vocal"], it.get("scene", ""), mood=pick)
            changed += 1
            with JOURNAL.open("a") as j:
                j.write(json.dumps({**it, **result, "rebalanced": True}) + "\n")
            if args.apply and it.get("record_id"):
                try:
                    write_fm(fm, it["record_id"], result)
                except Exception as e:
                    log.warning(f"  {it['filename']}: FileMaker write failed: {e}")
        top = lambda d: ", ".join(f"{k} {v}" for k, v in sorted(d.items(), key=lambda x: -x[1])[:6])
        log.info(f"{g}: {len(items)} tracks · {changed} moods changed{'' if args.apply else ' (dry run)'}")
        log.info(f"  before: {top(before)}")
        log.info(f"  after:  {top(after)}")


def main():
    ap = argparse.ArgumentParser(description="Sync-oriented mood and vocal tags for the catalogue")
    ap.add_argument("--genre", help="only these Local Genre values, comma separated (e.g. Marabi,Kwaito)")
    ap.add_argument("--limit", type=int, default=0, help="stop after N tracks (0 = all)")
    ap.add_argument("--retag", action="store_true", help="tag again even if already in the journal")
    ap.add_argument("--apply", action="store_true", help="write to FileMaker (AI_Tags, AI_Mood_v2, AI_Vocal, AI_Tag_Confidence)")
    ap.add_argument("--rebalance", action="store_true", help="re-pick moods within each --genre from the journal (no audio)")
    ap.add_argument("--config", default="config.json")
    args = ap.parse_args()

    cfg = load_config(args.config)
    fm = FileMakerAPI(cfg)
    fm.login()
    try:
        if args.rebalance:
            run_rebalance(args, cfg, fm)
        else:
            run_tagging(args, cfg, fm)
    finally:
        fm.logout()


if __name__ == "__main__":
    main()
