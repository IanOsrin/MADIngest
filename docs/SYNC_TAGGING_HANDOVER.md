# Handover — tagging the Gallo catalogue for sync

**Written:** 16 September 2026 · **Updated:** 16 September 2026, 16:45 — tagger version 2
**For:** Ian, another machine, or another Claude Code session picking this up

The job: give all 67,263 recordings a mood, a South African scene and a
vocal/instrumental flag, so the catalogue can be searched the way a music
supervisor writes a brief. Tags are produced by a model, then corrected by ear in
GalloIngest's **Tags** tab.

---

## 1. Where everything is

| Thing | Location | Notes |
|---|---|---|
| Tagger | `~/Desktop/MAD-Analyzer/sync_tagger.py` | Run from here. The master copy is in git: `GalloIngestV1.2/scripts/sync_tagger.py` — pull, then copy it over |
| Original analyzer | `~/Desktop/MAD-Analyzer/mad_analyzer.py` | BPM, key, energy, quality. Already run on 37,162 tracks |
| Credentials | `~/Desktop/MAD-Analyzer/config.json` | FileMaker + S3. Carry by hand, never by email |
| Tags tab (UI) | `GalloIngest/ingest/admin.html` + `routes/tags.js` | In git, live on gallo-ingest.onrender.com |
| GalloIngest | `github.com/IanOsrin/MADIngest` → `~/Desktop/GalloIngestV1.2` | push to `main` deploys in 15–60 s |
| MAD Music site | `github.com/IanOsrin/MadMusic` → `~/Downloads/madmusicv2.1` | merge `main` → `live` to deploy |

---

## 2. Set up the tagger on a new Mac

```bash
brew install python@3.12 ffmpeg          # ffmpeg is required: it decodes the audio
cd ~/Desktop/MAD-Analyzer
/opt/homebrew/bin/python3.12 -m venv venv-sync
./venv-sync/bin/pip install torch transformers requests boto3
```

**Do not copy or use the old `venv` folder.** It was created on a different
machine and its `pip` points at a Python that does not exist here — that failure
cost half an hour on 16 September. Leave it in place (the original analyzer still
uses it) and build `venv-sync` fresh.

First run downloads a 600 MB model to `~/.cache/huggingface`.

---

## 3. Updating a machine that is already tagging (version 1 → 2)

A machine running the earlier script should switch now; every genre it tags with
version 1 gets the Brass and Instrumental errors described in section 5.

1. **Stop the run** with Ctrl+C. Nothing is lost: finished tracks are in the journal.
2. **Keep its copy** in case it has changes of its own:
   `cp sync_tagger.py sync_tagger_v1_backup.py`
3. **Get version 2:**
   ```bash
   cd ~/Desktop/GalloIngestV1.2 && git pull
   cp scripts/sync_tagger.py ~/Desktop/MAD-Analyzer/sync_tagger.py
   ```
4. **Re-tag what version 1 already did**, genre by genre, starting with the two
   that have been checked:
   ```bash
   cd ~/Desktop/MAD-Analyzer
   caffeinate -i ./venv-sync/bin/python sync_tagger.py --genre Marabi,Kwaito --retag --apply
   ```
5. **Carry on** with the next genres (section 4).

The journal is shared between versions. Version 2 ignores version 1 entries, so a
plain run re-tags them automatically; `--retag` is only needed to redo version 2
work.

---

## 4. Run it

```bash
cd ~/Desktop/MAD-Analyzer

# a quick look — CSV only, nothing touches FileMaker
./venv-sync/bin/python sync_tagger.py --genre Maskandi --limit 20

# one or more genres, written to MadStreamer
caffeinate -i ./venv-sync/bin/python sync_tagger.py --genre Maskandi,Mbaqanga --apply

# spread the moods within a genre (reads the journal — no audio, a few seconds)
./venv-sync/bin/python sync_tagger.py --rebalance --genre Kwaito            # dry run: prints before/after
./venv-sync/bin/python sync_tagger.py --rebalance --genre Kwaito --apply    # writes

# everything not yet done
caffeinate -i ./venv-sync/bin/python sync_tagger.py --apply
```

- **Work genre by genre with `--genre`.** It finds just that genre in FileMaker
  instead of paging through all 67,000 records, and lets you check each genre
  before moving on. The value must match **Local Genre** exactly (e.g.
  `Township Jive`, `Boere Musiek`).
- **~10 seconds a track.** `caffeinate -i` stops the Mac sleeping mid-run.
- **Resumable.** Every track is journalled to `sync_tags_journal.jsonl`.
- **Output:** `sync_tags_v2.csv` — filename, genre, scene, mood, mood2,
  confidence, vocal, tags. (Version 1 wrote `sync_tags.csv` with other columns.)
- **Writes only four fields:** `AI_Tags`, `AI_Mood_v2`, `AI_Vocal`,
  `AI_Tag_Confidence`, on the **Song Files** layout. Never `AI_Mood`, `AI_BPM`,
  `AI_Key`, `AI_Energy` or `AI_Theme`.
- **Hand corrections are safe.** Anything saved in the Tags tab is stored at 100%
  confidence, and both tagging and `--rebalance` leave those records alone.

### When to rebalance

Some genres share one flavour, and the model picks it for nearly every track —
version 1 called 201 of 250 Kwaito tracks *Hypnotic*. `--rebalance` re-picks each
track's mood by what stands out **compared with the rest of its genre**, choosing
only from the track's own top four moods. Run the dry run first and read the
before/after lines; apply it if the "after" spread sounds right for that genre.
It needs at least 30 version-2 tracks in the genre.

### Fields in MadStreamer

| Field | Type | Needed on |
|---|---|---|
| `AI_Tags` | Text | Song Files + API_Album_Songs |
| `AI_Mood_v2` | Text | Song Files + API_Album_Songs |
| `AI_Vocal` | Text | Song Files + API_Album_Songs |
| `AI_Tag_Confidence` | Number | Song Files + API_Album_Songs |
| `AI_Theme` | Text | kept for hand-entered themes; the tagger no longer writes it |

**Song Files** is what the tagger writes to. **API_Album_Songs** is what the
website's nightly copy reads, so the Tags tab and any sync search need the fields
there too. A field not on the layout is invisible to the Data API and makes the
whole write fail. After adding fields: **Save Layout**, then **Exit Layout Mode**.

---

## 5. How the tags are produced (version 2)

`sync_tagger.py` uses **CLAP** (`laion/clap-htsat-unfused`), which scores audio
against written phrases. Three 10-second windows (15%, 45%, 75% through the
track) are averaged and compared with every phrase.

| Tag | Where it comes from |
|---|---|
| **Scene** | The track's **Local Genre**, from a fixed table (`GENRE_SCENE`): Marabi → Marabi piano, Kwaito → Kwaito street, Kwela → Kwela street, Mbaqanga → Mbaqanga groove, Maskandi → Maskandi guitar, Isicathamiya, Township Jive → Township jive, Bubblegum → Bubblegum 80s, Amapiano → Amapiano lounge, Gospel → Church hall, Boere Musiek and Volksmusiek → Boeremusiek dance, Cape Jazz → Cape goema, and Jazz from 1945–1969 → Sophiatown jazz. Other genres get no scene. |
| **Mood** | The model, from 15 moods. A second mood is added to the tags when it scores at least 70% of the first. |
| **Vocal** | The model (Instrumental, Vocal, Choir, Spoken), checked against the **Language** field: a real language rules out Instrumental; `zxx`, Instrumental or "No linguistic content" forces Instrumental; Spoken needs a score of 60% or more. Blank Language is left to the model. |
| **Confidence** | The chosen mood's score, 0–100. |

Scene names must match `TAG_VOCAB.scene` in `GalloIngest/routes/tags.js`.

### What version 1 got wrong (checked 16 September on all Marabi and Kwaito)

- **Brass on almost everything** — 127 of 131 Marabi, 202 of 250 Kwaito. Texture
  tags are no longer produced.
- **Instrumental on sung tracks** — 27 Marabi tracks tagged Instrumental had
  isiZulu as their language. Fixed by the Language check.
- **Spoken over-used** — 18 Marabi tracks. Now needs a strong score.
- **One mood per genre** — Hypnotic on 201 of 250 Kwaito. Second mood added;
  `--rebalance` available.
- **Theme** — empty or "Wedding". Dropped.
- **Worked well:** moods differ sensibly between genres (Marabi mostly Defiant
  and Playful), and scene-by-genre is consistent.

### Still to watch

- **Confidence is low** (Marabi averaged 28, Kwaito 38 in version 1). Use the Tags
  tab's "unsure" filter to hand-check the tracks you would actually pitch.
- **Blank Language** (about 12,600 tracks) means the vocal tag relies on the
  model alone for those.
- **Mood phrases** at the top of the script are the lever for better moods;
  rewrite a sentence, re-run a genre with `--retag`, compare.

---

## 6. Correcting tags: the Tags tab

Live at **gallo-ingest.onrender.com → Tags**.

- Filter by genre, mood, vocal/instrumental, or **"Tagged, but unsure (under
  40%)"** — the last one is where an ear is worth most.
- Each row shows artist, title, catalogue number, year, composers, ISRC, and
  **BPM, key, energy, length** in their own columns.
- Play the track, pick mood / theme / voice from the dropdowns, add scene tags
  with the chips, press Save.
- A tag you set is stored at **100% confidence**, so a later tagging run will not
  overwrite your judgement.
- Corrections go into MadStreamer immediately; the tab's filters catch up after
  the nightly sync (~01:00 UTC / 03:00 local).

---

## 7. Suggested order of work

1. **Switch any running machine to version 2** (section 3) and re-tag Marabi
   and Kwaito.
2. **Rebalance Kwaito** (dry run, read, then `--apply`).
3. **Listen to 10 tracks per genre** in the Tags tab before moving to the next
   genre. Fix obvious errors by hand; they are then protected.
4. **Next genres, in pitching order:** Mbaqanga, Maskandi, Township Jive, Kwela,
   Isicathamiya, Gospel, Instrumental, Jazz, Afro Soul, Bubblegum — then the rest
   with a plain `--apply`.
5. **Hand-check the shortlists.** Tracks that go to a supervisor should be heard
   by a person, not trusted to a model.

---

## 8. House rules that outlive any machine

- **Covers only through the pipeline** (`lib/album-cover.js`) — MAM tab, Artwork
  tab or S3 Upload. Never straight into `artwork/`.
- **Tracks match on catalogue + Filename**, never track order or title.
- **Deleting records is done by a person** in FileMaker, after checking.
- **Vision has no trash.** Nothing overwrites a master unless "overwrite" is ticked.
- **Never bulk-scan CMS 2024 Song Files** through the Data API; per-catalogue
  finds are fine.
- **The website reads a nightly copy** of MadStreamer. Changes appear the next
  morning — except hero banners, which are live within a minute.
- **Pull and restart** after anyone else pushes. `node server.js` has no hot reload.

---

## 9. Reference

- GalloIngest operations manual — https://claude.ai/artifact/Xu9i7eujJYSPkYuP7P3Ac1
- Machine handover (setup of both repos) — https://claude.ai/artifact/E5NWRLW3qUtxcJAvwfdTkv
- Income plan — https://claude.ai/artifact/94dKFMp7a5EidtBGnQSb3k
- Sync plan (what the tags are for) — https://claude.ai/artifact/VhSqtLUjy5qiLuUAUzAnQq
- Backups and journals from the 16 September repairs are in `~/Downloads`.
