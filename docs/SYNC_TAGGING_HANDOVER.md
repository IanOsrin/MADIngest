# Handover — tagging the Gallo catalogue for sync

**Written:** 16 September 2026, on the Mac currently doing the work
**For:** Ian, another machine, or another Claude Code session picking this up

The job: give all 67,263 recordings a mood, a South African scene, a use and a
vocal/instrumental flag, so the catalogue can be searched the way a music
supervisor writes a brief. Tags are produced by a model, then corrected by ear in
GalloIngest's **Tags** tab.

---

## 1. Where everything is

| Thing | Location | Notes |
|---|---|---|
| Tagger | `~/Desktop/MAD-Analyzer/sync_tagger.py` | **Not in git.** Holds no secrets itself; `config.json` beside it does |
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

## 3. Run it

```bash
cd ~/Desktop/MAD-Analyzer

# 1. a sample — writes sync_tags.csv ONLY, nothing touches FileMaker
./venv-sync/bin/python sync_tagger.py --limit 25

# 2. a chosen list of filenames, one per line (how the 195-track spread was done)
./venv-sync/bin/python sync_tagger.py --worklist sample200.txt

# 3. the real run — writes the five AI_* fields to MadStreamer
caffeinate -i ./venv-sync/bin/python sync_tagger.py --apply
```

- **~10 seconds a track.** The whole catalogue is roughly a week in the
  background. `caffeinate -i` stops the Mac sleeping mid-run.
- **Resumable.** Every track is journalled to `sync_tags_journal.jsonl`; a re-run
  skips anything already done. Delete the journal to start over.
- **Output:** `sync_tags.csv` — filename, scene, mood, confidence, theme, vocal, tags.
- **Safe by default.** Without `--apply` nothing is written anywhere but the CSV.
  Even with `--apply`, it writes only new fields and never touches `AI_Mood`,
  `AI_BPM`, `AI_Key` or `AI_Energy`.

### Before `--apply` will work

Five fields must exist in MadStreamer **and be placed on the layouts**:

| Field | Type | Needed on |
|---|---|---|
| `AI_Tags` | Text | Song Files + API_Album_Songs |
| `AI_Mood_v2` | Text | Song Files + API_Album_Songs |
| `AI_Theme` | Text | Song Files + API_Album_Songs |
| `AI_Vocal` | Text | Song Files + API_Album_Songs |
| `AI_Tag_Confidence` | Number | Song Files + API_Album_Songs |

**Song Files** is what the tagger writes to. **API_Album_Songs** is what the
website's nightly copy reads, so the Tags tab and any future sync search need
them there too. The FileMaker Data API cannot see a field that is not on the
layout, and it refuses the whole write if one is missing — the tab reports which.
After adding them: **Layouts → Save Layout**, then **Exit Layout Mode**, or the
API still will not see them.

---

## 4. How the tags are produced

`sync_tagger.py` uses **CLAP** (`laion/clap-htsat-unfused`), which scores audio
against written phrases. Three 10-second windows are taken from each track (15%,
45%, 75% of the way through), averaged, and compared with every phrase.

Essentia's own pretrained mood models would have been the obvious choice, but
`essentia-tensorflow` has no Apple Silicon build, which is why CLAP is used
instead. The original `mad_analyzer.py` still does BPM, key and energy with
Essentia and is unaffected.

The vocabulary is five groups of plain sentences at the top of the file:

- **MOODS** (15) — Joyful, Melancholic, Tender, Calm, Hypnotic, Defiant,
  Spiritual, Nostalgic, Playful, Dramatic, Lonely, Triumphant, Sensual,
  Restless, Solemn
- **THEMES** (12) — Film, Advertising, Documentary, Trailer, Sport, Party,
  Funeral, Wedding, Street, Rural, Opening, Closing
- **VOCAL** (4) — Instrumental, Vocal, Choir, Spoken
- **TEXTURE** (8) — Acoustic, Electric, Brass, Accordion, Percussive, Strings,
  Sparse, Lo-fi
- **SCENES** (22, South African) — Kwela street, Shebeen, Marabi piano,
  Sophiatown jazz, Cape goema, Mbaqanga groove, Maskandi guitar, Isicathamiya,
  Mine dance, Township jive, Bubblegum 80s, Kwaito street, Amapiano lounge,
  Church hall, Freedom song, Ancestral ceremony, Ululation, Bushveld, Karoo,
  Boeremusiek dance, Stadium crowd, Mission hymn

Each entry is `("Tag", "a sentence describing the sound")`. **Rewriting those
sentences is how the tags get better** — the model matches on the description,
not the tag. Example:

```python
("Maskandi guitar", "maskandi Zulu guitar picking with spoken praise poetry"),
```

**If you change the tag names**, change them in `GalloIngest/routes/tags.js`
(`TAG_VOCAB`) as well. The tab only offers words from that list, so the two must
match or a tag becomes uneditable.

---

## 5. What is known to be wrong (16 September)

A 195-track sample — 13 tracks from each of 15 genres — was run to judge quality.
Findings so far, from the first 54:

- **Good:** vocal / instrumental / choir / spoken looks reliable, including
  spotting a spoken passage on a boeremusiek track. "Church hall" for a gospel
  choir and "Boeremusiek dance" for the Afrikaans track were right.
- **Bad: "Sophiatown jazz" is over-used.** It landed on 1980s bubblegum and a
  1970s instrumental. The phrase is too easy for the model to reach for; it needs
  narrowing (state the era and big-band instrumentation) and probably competing
  phrases so there is somewhere better for those tracks to go.
- **Themes are weak in general.** In the earlier 6-track pilot five of six came
  out "Wedding" — the model choosing the nearest available word when nothing
  fits. Consider dropping or rewriting THEMES; mood, vocal and texture carry
  their weight.
- **Confidence runs 30–50%.** Normal for this kind of tagging: it means the model
  is choosing between two plausible moods. It is stored so you can filter to the
  confident ones and hand-check the rest.

Sample files: `sync_tags.csv` (current run, with scenes),
`sync_tags_pre_scenes.csv` (the earlier run without the South African phrases),
`sample200.txt` (the filenames used).

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

1. **Read the sample CSV** and mark which tags are wrong. Genre by genre is
   quickest.
2. **Rewrite the weak phrases** in `sync_tagger.py` — especially Sophiatown jazz
   and the themes. Keep the tag names stable if possible; if they change, update
   `routes/tags.js` too.
3. **Re-run the 195 sample** (delete `sync_tags.csv` and
   `sync_tags_journal.jsonl` first) and compare. Two or three rounds of this is
   worth more than any amount of model tuning.
4. **When the sample reads well**, add the five FileMaker fields, then run
   `--apply` across everything. Start with the genres you would pitch first —
   instrumentals, mbaqanga, gospel — using `--worklist`.
5. **Hand-check the shortlists.** The few hundred tracks that go to a supervisor
   should be heard by a person, not trusted to a model.

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
