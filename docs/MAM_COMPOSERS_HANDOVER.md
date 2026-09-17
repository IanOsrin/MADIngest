# Handover — composers missing on the MAM tab, and the standing cache conflict

**Written:** 17 September 2026
**For:** Ian, another machine, or another Claude Code session picking this up

Two faults, one root. The MAM tab showed an empty **Composers** column for
albums that plainly had composers, and the *Fill MAM from the metadata cache*
panel reported a permanent "MAM and the cache disagree" on the same field. Both
are fixed in `lib/fm-mam.js` and `lib/mam-cache-fill.js`. The DDEX consequence
below is the part that still needs work.

Found on **TGE 90** — *Stories Oor Jakkals En Wolf*, Roelf Jacobs, 5 tracks.

---

## 1. What was wrong

**MAM stores credits in two shapes.** Numbered singular slots (`Composer`,
`Composer 2`, `Composer 3`, `Composer 4`) and a plural field holding a
semicolon-separated list (`Composers`). Every write path fills both —
`createMamSong` in `lib/fm-mam-write.js`, and the `composer` builder in
`lib/cache-db-sync.js`. But albums merged in from the three source databases
(Catalogue, CMS, MadStreamer) carry only the plural one.

`mapMamRecord` in `lib/fm-mam.js` read only the singular slots:

```js
const composers = [s['Composer'], s['Composer 2'], s['Composer 3'], s['Composer 4']]
  .map(val).filter(Boolean)
const producers = [s['Producer'], s['Producers']].map(val).filter(Boolean)
```

Producers already read the plural. Composers didn't. Plural-only records
therefore produced an empty array, and an empty array renders as an empty cell.

**The cache keeps Ingrooves' role tags.** `lib/metadata-cache.js` stores the
`Writers / Composers` column verbatim. TGE 90's five rows all read:

```
Pieter W. Grobbelaar <Lyricist>, Pieter W. Grobbelaar <Composer>
```

`songFillsFrom` strips those tags and dedupes before offering the value, so the
cache side of a comparison collapses to `Pieter W. Grobbelaar`. The MAM side got
no such treatment, and `tn()` strips `(…)` and `[…]` but **not** `<…>` — so MAM
normalised to `…grobbelaar lyricist…` and never matched. Every affected album
reported a composer conflict against a value identical to its own.

**Why the two symptoms looked contradictory.** The tab reads `Composer`; the
cache comparison reads `Composers`. A blank column and a reported disagreement
at the same time was the tell: the record was never empty.

---

## 2. What changed

| File | Change |
|---|---|
| `lib/fm-mam.js` | `mapMamRecord` reads both credit shapes through one `creditList` helper — splits on `;`, dedupes. Applied to composers **and** producers |
| `lib/mam-cache-fill.js` | `conflictsWith` tag-strips credit fields on the MAM side too, via the existing `stripTags`. `CREDIT_FIELDS` = Composers, Composer, Producers, Producer, Publishers |

**Follow-up, applied the same day on Ian's Mac.** A live read of TGE 90 showed
MAM's *own* fields hold the tagged Ingrooves form too: `Composers` is
`Pieter W. Grobbelaar <Lyricist>, Pieter W. Grobbelaar <Composer>` on all five
tracks, and track 5 also has `Composer` / `Composer 2` holding one tagged name
each. With `creditList` splitting on `;` only, the tab showed the tags and DDEX
would have shipped one writer called "…<Lyricist>, …<Composer>" (track 5: three
entries). `creditList` now strips `<…>` role tags, splits a *tagged* value on
commas as well, and dedupes case-insensitively. An untagged value still splits on
`;` only, so a surname-first "Mankwane, Marks" stays one name. Result on TGE 90:
`Pieter W. Grobbelaar`, once, on every track; 0 composer conflicts in the cache
fill plan. The Lyricist/Composer distinction is dropped — DDEX already sent
every writer with the Composer role, so nothing it used is lost.

The dedupe is not cosmetic. Producers already read `Producer` **and**
`Producers`, both of which every write path fills with the same string — so any
record written through the album tab has been showing "Hamilton Nzimande;
Hamilton Nzimande" and shipping it twice in DDEX. That is fixed as a side
effect. If it is unwanted, `creditList(s['Producer'], s['Producers'])` is the
one line to revert.

The MAM side is still **displayed raw** in the conflict panel. The operator
should see what is actually in the field, not a cleaned-up version of it.

Deliberately unchanged: a genuine difference is still a conflict. A different
name, or the same name written surname-first (`Grobbelaar Pieter W`, which is
how the Publishers column writes it on these very rows), is still reported.

**Tested** — 13 assertions against the real TGE 90 values, all passing:
plural-only reads; both-shapes yields no duplicate; numbered slots still work;
tagged-vs-stripped is no longer a conflict; a different name still is; non-credit
fields untouched.

---

## 3. Getting it onto the server

The fix is commit `a6ba9cd`, and this document is the commit after it, both
authored as Claude. Neither could be pushed from the Cowork session — the git
proxy refuses to inject a credential for `IanOsrin/MADIngest`, which is
read-only from there. So they travel as patches.

```bash
cd ~/Desktop/galloingestv1.2
git stash push -u                 # if the local date scripts are still uncommitted
git pull origin main
git am ~/Downloads/0001-*.patch ~/Downloads/0002-*.patch
git push origin main              # Render redeploys in 15–60 s
```

Apply them in order — `0001` is the fix, `0002` is this file.

If `git am` refuses, `git apply` the same file and commit it by hand.

Note on the 16–17 September pull failure that preceded this: `git stash push -u
-m my local date scripts` was run **unquoted**, so git read `my` as the message
and the rest as pathspecs, saved nothing, and the pull failed identically the
second time. Quote the message.

---

## 4. Verifying

1. Open the **MAM** tab, load **TGE 90**. The Composers column should read
   `Pieter W. Grobbelaar` on all five tracks.
2. Open **Fill MAM from the metadata cache** for the same catalogue. The
   composer row should be gone from "MAM and the cache disagree".
3. If it is *still* there, read what the MAM side prints. A surviving conflict
   means MAM holds a genuinely different rendering — most likely surname-first —
   and that is a data decision for a person, not a bug.
4. Spot-check one album that has the numbered slots populated (anything created
   through the album tab recently) and confirm no name appears twice.

---

## 5. Still outstanding

**The DDEX exposure — do this before the next Ingrooves delivery.**
`mapMamRecord` also feeds `findMamRecordsByCatalogue`, which feeds
`lib/ddex-build.js`, which builds `IndirectResourceContributor` from
`t.composers`. Every package built from a plural-only MAM record has shipped
with **no writer credits at all**. Nobody has scanned how many albums or which
deliveries. That audit has not been written.

Rough shape of it: page the MAM Songs layout, count records where `Composers`
has a value and all four singular slots are empty, group by `Album Catalogue`,
and cross-reference against what has already gone to Ingrooves. Model it on
`scripts/scan-runaway2.mjs`, which already pages MAM and knows the credit
fields.

**Is `Composer` even on the Songs layout?** `updateMamSong` passes every write
through `filterToMamLayout`, which silently drops fields the FileMaker layout
does not expose. If the singular field is not on the layout, every write to it
has been discarded and the singular slots will stay empty forever — which is
consistent with everything observed, but was never confirmed against FileMaker.
Worth five minutes in Layout Mode. A field missing from a layout is invisible to
the Data API; that same rule bit the sync tagger (see the tagging handover,
section 4).

**Publishers has the same shape of problem.** TGE 90's cache rows carry
`Grobbelaar Pieter W <SAMRO>`. The comparison now strips that tag, but nothing
has checked what MAM actually holds in `Publishers` across the catalogue, or
whether the society tag is worth keeping somewhere rather than discarding.

---

## 6. House rules that applied here

- **Fill blanks and replace values are different decisions.** `gapsOnly` and
  `conflictsWith` stay separate all the way to the patch. Nothing overwrites an
  existing MAM value unless a field was ticked by name.
- **The cache is a good source, not an authority.** A standing false conflict is
  dangerous precisely because someone eventually ticks it — and overwrites a
  good value with a reformat of itself.
- **Match on normalised title, never on position.** Cache rows and MAM tracks do
  not agree on numbering.
- **A field not on the FileMaker layout is invisible to the Data API**, and a
  write to it fails or is dropped without complaint.
- **Pull and restart** after anyone pushes — `node server.js` has no hot reload.

---

## 7. Reference

| Thing | Where |
|---|---|
| Repo | `github.com/IanOsrin/MADIngest` → `~/Desktop/galloingestv1.2` |
| The fix | commit `a6ba9cd`, `lib/fm-mam.js` + `lib/mam-cache-fill.js` |
| Cache source | `Gallo_Metadata_Extract.xlsx` in the repo root — TGE 90 is 5 rows, ISRC `ZA78E131407[1-5]` |
| Credit writers | `lib/fm-mam-write.js` `createMamSong`, `lib/cache-db-sync.js` `MAM_SONG_BUILDERS.composer` |
| Credit readers | `lib/fm-mam.js` `mapMamRecord`, `lib/publish-album.js`, `scripts/scan-runaway2.mjs` |
| Comma damage in credits | `scripts/fix-and-commas.mjs` — the old "and" → "," find/replace, unrelated but lives in the same fields |
| Sync tagging handover | `docs/SYNC_TAGGING_HANDOVER.md` |
