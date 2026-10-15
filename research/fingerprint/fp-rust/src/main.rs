//! fp_match — the fingerprint lab's pitch-sweep matcher in Rust (2026-10-09).
//!
//! The same decisions as research/fingerprint/fp_landmark.py `match` + the sweep in `_sweep_job`:
//!   · a query's peaks are re-paired at 9 pitches (−2…+2 semitones in half steps) by scaling the
//!     peak frequencies (numpy rint = round half to even), then hashed exactly like `hashes()`
//!   · every hash present in at most 400 postings votes for (track, time offset)
//!   · a track's score = its best single offset; ties go the way Python's dict order sends them
//!     (the offset / track first met while voting); a pitch only replaces the best if it scores MORE
//! The index is the 10k run's on-disk layout: rows of (hash u32, track u32, time u16), sorted by hash.
//!
//!   fp_match <index.rows> <names.json> <peaks.bin> <queries.json> <out.json> [threads]

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const FANOUT: usize = 8;
const DT_MIN: i32 = 2;
const DT_MAX: i32 = 64;
const DF_MAX: i32 = 63;
/// A hash in more postings than this says nothing and is skipped (fp_landmark: 400). FP_STOP overrides
/// it, to see what the cutoff costs on a bigger index.
fn stop_postings() -> usize {
    static S: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *S.get_or_init(|| std::env::var("FP_STOP").ok().and_then(|v| v.parse().ok()).unwrap_or(400))
}
const SWEEP: [f64; 9] = [-2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0];

struct Index {
    start: Vec<u32>, // start[h]..start[h+1] = the postings of hash h
    track: Vec<u32>,
    time: Vec<u16>,
}

fn read_u32s(path: &std::path::Path) -> Vec<u32> {
    fs::read(path).expect("index file").chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// A file of 10-byte rows (the lab export), or the scale run's folder: hash.u32 · track.u32 · time.u16.
fn load_index(path: &str) -> Index {
    let p = std::path::Path::new(path);
    let (hashes, track, time): (Vec<u32>, Vec<u32>, Vec<u16>) = if p.is_dir() {
        let time = fs::read(p.join("time.u16")).expect("time.u16").chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        (read_u32s(&p.join("hash.u32")), read_u32s(&p.join("track.u32")), time)
    } else {
        let b = fs::read(path).expect("index");
        let n = b.len() / 10;
        let (mut h, mut tr, mut ti) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
        for r in b.chunks_exact(10) {
            h.push(u32::from_le_bytes([r[0], r[1], r[2], r[3]]));
            tr.push(u32::from_le_bytes([r[4], r[5], r[6], r[7]]));
            ti.push(u16::from_le_bytes([r[8], r[9]]));
        }
        (h, tr, ti)
    };
    assert!(hashes.len() == track.len() && track.len() == time.len(), "index files disagree on length");
    let max_h = hashes.iter().copied().max().unwrap_or(0);
    let mut start = vec![0u32; max_h as usize + 2];
    for &h in &hashes {
        start[h as usize + 1] += 1;
    }
    for i in 1..start.len() {
        start[i] += start[i - 1];
    }
    assert!(hashes.windows(2).all(|w| w[0] <= w[1]), "index rows must be sorted by hash");
    Index { start, track, time }
}

impl Index {
    fn postings(&self, h: u32) -> (usize, usize) {
        let h = h as usize;
        if h + 1 >= self.start.len() {
            return (0, 0);
        }
        (self.start[h] as usize, self.start[h + 1] as usize)
    }
}

/// fp_landmark.hashes(): (hash, time of the first peak) for every peak pair.
fn hashes(pk: &[(i32, i32)], out: &mut Vec<(u32, i32)>) {
    out.clear();
    let n = pk.len();
    for i in 0..n {
        let (t1, f1) = pk[i];
        let (mut j, mut pairs) = (i + 1, 0);
        while j < n && pairs < FANOUT {
            let (t2, f2) = pk[j];
            let dt = t2 - t1;
            if dt < DT_MIN {
                j += 1;
                continue;
            }
            if dt > DT_MAX {
                break;
            }
            let df = f2 - f1;
            if df.abs() <= DF_MAX {
                out.push((((f1 << 13) | ((df + 64) << 6) | dt) as u32, t1));
                pairs += 1;
            }
            j += 1;
        }
    }
}

/// fp_landmark.hashes_scaled(): the peaks with every frequency × ratio (numpy rint), outside 0…511 dropped.
fn scaled(pk: &[(i32, i32)], ratio: f64, out: &mut Vec<(i32, i32)>) {
    out.clear();
    if ratio == 1.0 {
        out.extend_from_slice(pk);
        return;
    }
    for &(t, f) in pk {
        let g = (f as f64 * ratio).round_ties_even();
        if (0.0..=511.0).contains(&g) {
            out.push((t, g as i32));
        }
    }
}

/// fp_landmark.match(top=1): (track, votes, offset in frames).
fn best_match(q: &[(u32, i32)], ix: &Index, votes: &mut Vec<(u64, u32)>) -> Option<(u32, u32, i32)> {
    votes.clear();
    let mut seq = 0u32; // the order Python's dict meets each (track, offset)
    for &(h, t) in q {
        let (a, b) = ix.postings(h);
        if a == b || b - a > stop_postings() {
            continue;
        }
        for p in a..b {
            let off = ix.time[p] as i32 - t;
            let key = ((ix.track[p] as u64) << 32) | (off as i64 + (1i64 << 31)) as u64;
            votes.push((key, seq));
            seq += 1;
        }
    }
    if votes.is_empty() {
        return None;
    }
    votes.sort_unstable();
    // Walk the (track, offset) runs: count, first time met; per track keep the best run.
    // best = (count, -first_seq_of_run) max; track order for ties = the first time the track was met.
    let mut best: Option<(u32, u32, i32, u32)> = None; // (track, count, offset, track_first_seq)
    let mut i = 0;
    let mut cur: Option<(u32, u32, i32, u32, u32)> = None; // (track, count, offset, run_first_seq, track_first_seq)
    let finish = |c: Option<(u32, u32, i32, u32, u32)>, best: &mut Option<(u32, u32, i32, u32)>| {
        if let Some((tid, cnt, off, _, tfirst)) = c {
            let better = match *best {
                None => true,
                Some((_, bc, _, bf)) => cnt > bc || (cnt == bc && tfirst < bf),
            };
            if better {
                *best = Some((tid, cnt, off, tfirst));
            }
        }
    };
    while i < votes.len() {
        let key = votes[i].0;
        let mut j = i;
        while j < votes.len() && votes[j].0 == key {
            j += 1;
        }
        let (cnt, first) = ((j - i) as u32, votes[i].1); // sorted by seq within the run
        let tid = (key >> 32) as u32;
        let off = ((key & 0xffff_ffff) as i64 - (1i64 << 31)) as i32;
        match cur {
            Some((ct, cc, co, cf, tf)) if ct == tid => {
                // Python: the first offset to reach the track's maximum keeps it
                let (nc, no, nf) = if cnt > cc || (cnt == cc && first < cf) { (cnt, off, first) } else { (cc, co, cf) };
                cur = Some((ct, nc, no, nf, tf.min(first)));
            }
            _ => {
                finish(cur, &mut best);
                cur = Some((tid, cnt, off, first, first));
            }
        }
        i = j;
    }
    finish(cur, &mut best);
    best.map(|(t, c, o, _)| (t, c, o))
}

fn read_peaks(path: &str) -> Vec<Vec<(i32, i32)>> {
    let b = fs::read(path).expect("peaks");
    let (mut out, mut p) = (Vec::new(), 0);
    let i32at = |p: usize| i32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]);
    while p < b.len() {
        let n = u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) as usize;
        p += 4;
        out.push((0..n).map(|k| (i32at(p + k * 8), i32at(p + k * 8 + 4))).collect());
        p += n * 8;
    }
    out
}

/// A JSON array of strings (names.json / queries.json) — the files are ours, plain strings only.
fn read_strings(path: &str) -> Vec<String> {
    let s = fs::read_to_string(path).expect("json");
    let (mut out, mut cur, mut inside, mut esc) = (Vec::new(), String::new(), false, false);
    for ch in s.chars() {
        if inside {
            if esc {
                cur.push(ch);
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                out.push(std::mem::take(&mut cur));
                inside = false;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            inside = true;
        }
    }
    out
}

fn json_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}


// ── Whole-song scan (the "Check this audio" tab, 2026-10-11) ─────────────────────────────────
// A suspect track can hold several Gallo recordings at different places, so instead of one best
// (track, offset) for the whole query, every (track, offset) is kept and its votes are grouped by
// WHERE in the suspect they fell: a run of votes no more than GAP frames apart is one stretch.
// A stretch counts only with at least MIN votes — the same bar the lab measured (≥ 20: 0 false
// positives against 9,962 tracks). Each of the 9 pitches is scanned; parts of one sample found at
// neighbouring offsets (tempo drift) are joined for display only after each has passed on its own.

const GAP: u32 = 215; // 5 s of frames: a pause longer than this ends a stretch
const WINDOW: u32 = 431; // 10 s of frames: the votes that count must sit this close together
const MAX_FRAMES: i32 = 65_535; // query time is packed in 16 bits (~25 min)

fn min_votes() -> u32 {
    static S: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *S.get_or_init(|| std::env::var("FP_MIN_VOTES").ok().and_then(|v| v.parse().ok()).unwrap_or(20))
}

#[derive(Clone, Debug)]
struct Stretch {
    track: u32,
    off: i32,      // index time − query time, in frames
    q_start: u32,  // first and last query frame that voted
    q_end: u32,
    votes: u32,
    semis: f64,
}

fn scan_pitch(pk: &[(i32, i32)], ratio: f64, semis: f64, ix: &Index) -> Vec<Stretch> {
    let (mut sp, mut hh) = (Vec::new(), Vec::new());
    scaled(pk, ratio, &mut sp);
    hashes(&sp, &mut hh);
    // one u64 per vote: track (20 bits) | offset + 65536 (17 bits) | query frame (16 bits)
    let mut v: Vec<u64> = Vec::new();
    for &(h, t) in &hh {
        if !(0..=MAX_FRAMES).contains(&t) {
            continue;
        }
        let (a, b) = ix.postings(h);
        if a == b || b - a > stop_postings() {
            continue;
        }
        for p in a..b {
            let off = ix.time[p] as i32 - t + 65_536;
            v.push(((ix.track[p] as u64) << 33) | ((off as u64) << 16) | t as u64);
        }
    }
    v.sort_unstable();
    let mut out = Vec::new();
    let mn = min_votes();
    let mut i = 0;
    while i < v.len() {
        let key = v[i] >> 16;
        let mut j = i;
        while j < v.len() && v[j] >> 16 == key {
            j += 1;
        }
        if (j - i) as u32 >= mn {
            let track = (key >> 17) as u32;
            let off = (key & 0x1_ffff) as i32 - 65_536;
            let mut k = i;
            while k < j {
                let (mut e, start) = (k, (v[k] & 0xffff) as u32);
                while e + 1 < j && ((v[e + 1] & 0xffff) as u32) - ((v[e] & 0xffff) as u32) <= GAP {
                    e += 1;
                }
                let votes = (e - k + 1) as u32;
                // …and at least MIN of them inside some 10 s — the lab's clips were 5–10 s, and a whole
                // song otherwise lets thin coincidences chain up over half a minute (2 of 20 stranger songs).
                let (mut dense, mut lo) = (0u32, k);
                for hi in k..=e {
                    while ((v[hi] & 0xffff) as u32) - ((v[lo] & 0xffff) as u32) > WINDOW {
                        lo += 1;
                    }
                    dense = dense.max((hi - lo + 1) as u32);
                }
                if votes >= mn && dense >= mn {
                    out.push(Stretch { track, off, q_start: start, q_end: (v[e] & 0xffff) as u32, votes, semis });
                }
                k = e + 1;
            }
        }
        i = j;
    }
    out
}

/// Every stretch of the suspect that holds an indexed recording, strongest first.
fn scan_song(pk: &[(i32, i32)], ix: &Index) -> Vec<Stretch> {
    let ratios: Vec<(f64, f64)> = SWEEP.iter().map(|&s| (s, 2f64.powf(-s / 12.0))).collect();
    let mut all: Vec<Stretch> = Vec::new();
    for chunk in ratios.chunks(3) {
        // three pitches at a time keeps a 20-minute scan's vote lists under ~1 GB
        let found: Vec<Vec<Stretch>> = std::thread::scope(|sc| {
            let hs: Vec<_> = chunk.iter().map(|&(s, r)| sc.spawn(move || scan_pitch(pk, r, s, ix))).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        all.extend(found.into_iter().flatten());
    }
    // The same place found at several pitches or offsets: keep the strongest.
    all.sort_by(|a, b| b.votes.cmp(&a.votes).then(a.semis.abs().partial_cmp(&b.semis.abs()).unwrap()));
    let mut kept: Vec<Stretch> = Vec::new();
    for s in all {
        // (any offset: a song's own repeats — the chorus again — land on the same stretch of the suspect)
        let dup = kept.iter().any(|k| k.track == s.track && s.q_start <= k.q_end && k.q_start <= s.q_end);
        if !dup {
            kept.push(s);
        }
    }
    // Neighbouring offsets of one track that overlap or touch in the suspect (a sample drifting in
    // tempo) become one stretch; every part has already passed the vote bar on its own.
    kept.sort_by_key(|s| (s.track, s.q_start));
    let mut merged: Vec<Stretch> = Vec::new();
    for s in kept {
        if let Some(m) = merged.last_mut() {
            if m.track == s.track && (m.off - s.off).abs() <= 6 * 43 && s.q_start <= m.q_end + GAP {
                m.q_end = m.q_end.max(s.q_end);
                if s.votes > m.votes {
                    m.off = s.off;
                    m.semis = s.semis;
                }
                m.votes += s.votes;
                continue;
            }
        }
        merged.push(s);
    }
    merged.sort_by(|a, b| b.votes.cmp(&a.votes));
    merged
}

/// `fp_match serve <index> <names.json>`: load once, then one request per stdin line —
/// "<id>\t<peaks file>" (u32 count, then count × (i32 frame, i32 bin)) → one JSON line on stdout.
fn serve(index: &str, names_path: &str) {
    use std::io::{BufRead, Write};
    let t0 = Instant::now();
    let ix = load_index(index);
    let names = read_strings(names_path);
    eprintln!("[fp_match] {} rows, {} tracks loaded in {:.1} s", ix.track.len(), names.len(), t0.elapsed().as_secs_f64());
    let fr = |f: f64| (f * 256.0 / 11025.0 * 100.0).round() / 100.0; // frames → seconds (HOP / SR)
    let mut out = std::io::stdout().lock();
    writeln!(out, "{{\"ready\":true,\"tracks\":{},\"rows\":{}}}", names.len(), ix.track.len()).unwrap();
    out.flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        let (id, path) = match line.split_once('\t') { Some(x) => x, None => continue };
        let t = Instant::now();
        let reply = match std::panic::catch_unwind(|| read_peaks(path)) {
            Ok(mut p) if p.len() == 1 => {
                let pk = p.remove(0);
                let found = scan_song(&pk, &ix);
                let items: Vec<String> = found.iter().take(50).map(|s| format!(
                    "{{\"file\":{},\"votes\":{},\"semitones\":{:?},\"q_start\":{},\"q_end\":{},\"ref_start\":{}}}",
                    json_str(names.get(s.track as usize).map(|n| n.as_str()).unwrap_or("")), s.votes, s.semis,
                    fr(s.q_start as f64), fr(s.q_end as f64), fr(s.q_start as f64 + s.off as f64))).collect();
                format!("{{\"id\":{},\"ok\":true,\"peaks\":{},\"ms\":{},\"matches\":[{}]}}", json_str(id), pk.len(), t.elapsed().as_millis(), items.join(","))
            }
            _ => format!("{{\"id\":{},\"ok\":false,\"error\":\"unreadable peaks file\"}}", json_str(id)),
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}

// ── Catalogue self-scan (2026-10-12): which indexed recordings carry the same audio? ──────────
// Every recording's own fingerprints are looked up in the index; another recording whose
// fingerprints line up at ONE time offset shares audio with it — all of it (the same recording
// filed twice) or a stretch (a medley, a re-release edit, a sample). The same bar as the Check Audio
// scan: ≥ MIN votes inside 10 s. Only pairs A < B are scored (each pair once). No audio is needed —
// the index already holds every recording's fingerprints, grouped here by recording.
//   fp_match selfscan <index dir> <names.json> <out.tsv> [threads]
// out.tsv: a, b, votes, dense, a_from, a_to, b_from (seconds), a_hashes, b_hashes
fn selfscan(index: &str, names_path: &str, out_path: &str, threads: usize) {
    let t0 = Instant::now();
    let ix = load_index(index);
    let names = read_strings(names_path);
    let nt = names.len();
    // rows of each recording (counting sort by track) — row indices, so no second copy of the hashes
    let mut cnt = vec![0u32; nt + 1];
    for &t in &ix.track { cnt[t as usize + 1] += 1; }
    for i in 1..cnt.len() { cnt[i] += cnt[i - 1]; }
    let mut fill = cnt.clone();
    let mut rows = vec![0u32; ix.track.len()];
    for (r, &t) in ix.track.iter().enumerate() { rows[fill[t as usize] as usize] = r as u32; fill[t as usize] += 1; }
    drop(fill);
    eprintln!("[selfscan] {} rows, {} recordings ready in {:.0} s", ix.track.len(), nt, t0.elapsed().as_secs_f64());
    let hash_of = |row: u32| -> u32 { (ix.start.partition_point(|&s| s <= row) - 1) as u32 };
    let fr = |f: f64| (f * 256.0 / 11025.0 * 10.0).round() / 10.0;
    let mn = min_votes();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let lines: Vec<String> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
            let (mut v, mut out): (Vec<u64>, Vec<String>) = (Vec::new(), Vec::new());
            loop {
                let a = next.fetch_add(1, Ordering::Relaxed);
                if a >= nt { break; }
                let (r0, r1) = (cnt[a] as usize, cnt[a + 1] as usize);
                v.clear();
                for &row in &rows[r0..r1] {
                    let (t, h) = (ix.time[row as usize] as i64, hash_of(row));
                    let (p0, p1) = ix.postings(h);
                    if p1 - p0 > stop_postings() { continue; }
                    for p in p0..p1 {
                        let b = ix.track[p] as usize;
                        if b <= a { continue; }
                        let off = ix.time[p] as i64 - t + 65_536;
                        v.push(((b as u64) << 33) | ((off as u64) << 16) | t as u64);
                    }
                }
                v.sort_unstable();
                // per other recording: its best stretch (most votes) at one offset
                let mut best: Option<(usize, u32, u32, u32, u32, i64)> = None; // b, votes, dense, from, to, off
                let flush = |best: &mut Option<(usize, u32, u32, u32, u32, i64)>, out: &mut Vec<String>| {
                    if let Some((b, votes, dense, from, to, off)) = best.take() {
                        out.push(format!("{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}", names[a], names[b], votes, dense,
                            fr(from as f64), fr(to as f64), fr(from as f64 + off as f64), r1 - r0, cnt[b + 1] - cnt[b]));
                    }
                };
                let mut i = 0;
                while i < v.len() {
                    let key = v[i] >> 16;
                    let mut j = i;
                    while j < v.len() && v[j] >> 16 == key { j += 1; }
                    let b = (key >> 17) as usize;
                    if best.map_or(false, |x| x.0 != b) { flush(&mut best, &mut out); }
                    if (j - i) as u32 >= mn {
                        let off = (key & 0x1_ffff) as i64 - 65_536;
                        let mut k = i;
                        while k < j {
                            let mut e = k;
                            while e + 1 < j && ((v[e + 1] & 0xffff) as u32) - ((v[e] & 0xffff) as u32) <= GAP { e += 1; }
                            let (mut dense, mut lo) = (0u32, k);
                            for hi in k..=e {
                                while ((v[hi] & 0xffff) as u32) - ((v[lo] & 0xffff) as u32) > WINDOW { lo += 1; }
                                dense = dense.max((hi - lo + 1) as u32);
                            }
                            let votes = (e - k + 1) as u32;
                            if votes >= mn && dense >= mn && best.map_or(true, |x| x.0 != b || votes > x.1) {
                                best = Some((b, votes, dense, (v[k] & 0xffff) as u32, (v[e] & 0xffff) as u32, off));
                            }
                            k = e + 1;
                        }
                    }
                    i = j;
                }
                flush(&mut best, &mut out);
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                if d % 500 == 0 { eprintln!("[selfscan] {d}/{nt} · {:.0} s", t0.elapsed().as_secs_f64()); }
            }
            out
        })).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let mut body = String::from("a\tb\tvotes\tdense\ta_from\ta_to\tb_from\ta_hashes\tb_hashes\n");
    for l in &lines { body.push_str(l); body.push('\n'); }
    fs::write(out_path, body).expect("write");
    eprintln!("[selfscan] {} pairs share audio · {:.0} s", lines.len(), t0.elapsed().as_secs_f64());
}

// ── Fingerprint design test (2026-10-12) ────────────────────────────────────────────────────
// Today's words are PAIRS of peaks packed into 22 bits — ~4M possible words, so at the full
// catalogue (~65k recordings) every word would sit in ~700 recordings while the matcher ignores
// words in more than 400. This rebuilds each indexed recording's peaks FROM THE INDEX (a pair word
// holds both its peaks: f1 | df | dt at time t1), re-fingerprints all of them with a candidate
// design, and runs the lab's query clips against it — no audio download.
//   fp_match design <scale index dir> <names.json> <peaks.bin> <queries.json> <out dir> <design> [stop]
// designs: pairs (today's, rebuilt), trip (3 peaks), tripq (3 peaks, time steps of 2 frames)
#[derive(Clone, Copy, PartialEq)]
enum Design { Pairs, Trip, TripQ }

const TRIP_K: usize = 5; // an anchor's first 5 partners → 10 triplets (today: 8 pairs)

#[inline]
fn mix32(x: u64) -> u32 { (x.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32) as u32 }

fn design_hashes(pk: &[(i32, i32)], d: Design, out: &mut Vec<(u32, i32)>) {
    out.clear();
    if d == Design::Pairs {
        hashes(pk, out);
        for x in out.iter_mut() { x.0 = (x.0 as u32).wrapping_mul(0x9E37_79B1); } // a bijection: no new collisions
        return;
    }
    let n = pk.len();
    let mut cand: Vec<(i32, i32)> = Vec::with_capacity(TRIP_K);
    for i in 0..n {
        let (t1, f1) = pk[i];
        cand.clear();
        let mut j = i + 1;
        while j < n && cand.len() < TRIP_K {
            let (t2, f2) = pk[j];
            let (dt, df) = (t2 - t1, f2 - f1);
            j += 1;
            if dt < DT_MIN { continue; }
            if dt > DT_MAX { break; }
            if df.abs() <= DF_MAX { cand.push((dt, df)); }
        }
        for a in 0..cand.len() {
            for b in a + 1..cand.len() {
                let q = |dt: i32| if d == Design::TripQ { dt / 2 } else { dt } as u64;
                let key = ((f1 as u64) << 26) | (((cand[a].1 + 64) as u64) << 19) | (q(cand[a].0) << 13)
                        | (((cand[b].1 + 64) as u64) << 6) | q(cand[b].0);
                out.push((mix32(key), t1));
            }
        }
    }
}

struct DIndex { bucket: Vec<u32>, rows: Vec<u64> } // rows: hash(32) | track(16) | time(16), sorted

impl DIndex {
    fn postings(&self, h: u32) -> &[u64] {
        let b = (h >> 8) as usize;
        let s = &self.rows[self.bucket[b] as usize..self.bucket[b + 1] as usize];
        let lo = s.partition_point(|&r| ((r >> 32) as u32) < h);
        let hi = s.partition_point(|&r| ((r >> 32) as u32) <= h);
        &s[lo..hi]
    }
}

/// Every indexed recording's landmark peaks, rebuilt from a pair-word index (each word holds both its
/// peaks: f1 | df | dt at t1) — one recording at a time, so the ~16 copies of each peak never all sit in memory.
fn rebuild_peaks(index: &str, names_path: &str) -> Vec<Vec<(i32, i32)>> {
        let ix = load_index(index);
        let nt = read_strings(names_path).len();
        let mut cnt = vec![0u32; nt + 1];
        for &t in &ix.track { cnt[t as usize + 1] += 1; }
        for i in 1..cnt.len() { cnt[i] += cnt[i - 1]; }
        let mut fill = cnt.clone();
        let mut rows = vec![0u32; ix.track.len()];
        for (r, &t) in ix.track.iter().enumerate() { rows[fill[t as usize] as usize] = r as u32; fill[t as usize] += 1; }
        drop(fill);
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let per = (nt + threads - 1) / threads;
        let parts: Vec<Vec<Vec<(i32, i32)>>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..threads).map(|k| { let (ix, rows, cnt) = (&ix, &rows, &cnt); sc.spawn(move || {
                let mut out = Vec::new();
                for tr in (k * per)..((k + 1) * per).min(nt) {
                    let mut v: Vec<(i32, i32)> = Vec::new();
                    for &row in &rows[cnt[tr] as usize..cnt[tr + 1] as usize] {
                        let h = ix.start.partition_point(|&s| s <= row) - 1;
                        let (f1, mut df, mut dt) = ((h >> 13) as i32, ((h >> 6) & 127) as i32 - 64, (h & 63) as i32);
                        // dt = 64 (DT_MAX) overflows the 6-bit field into df: packed as df+1 with dt 0. Real
                        // gaps start at DT_MIN = 2, so a 0 can only be that — unpack it, or a phantom peak appears.
                        if dt == 0 { dt = 64; df -= 1; }
                        let t1 = ix.time[row as usize] as i32;
                        v.push((t1, f1)); v.push((t1 + dt, f1 + df));
                    }
                    v.sort_unstable(); v.dedup(); v.shrink_to_fit();
                    out.push(v);
                }
                out
            }) }).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        parts.into_iter().flatten().collect()
    }

fn design_test(index: &str, names_path: &str, peaks_path: &str, queries_path: &str, out_dir: &str, d: Design, stop: usize) {
    let t0 = Instant::now();
    // 1. every recording's peaks, rebuilt from the scale index
    let mut peaks = rebuild_peaks(index, names_path);
    let npk: usize = peaks.iter().map(|v| v.len()).sum();
    eprintln!("[design] peaks rebuilt: {npk} across {} recordings · {:.0} s", peaks.len(), t0.elapsed().as_secs_f64());
    // 2. the candidate design's index
    let mut hh = Vec::new();
    let mut total = 0usize;
    for v in &peaks { design_hashes(v, d, &mut hh); total += hh.len(); }
    let mut rows: Vec<u64> = Vec::with_capacity(total);
    for (tr, v) in peaks.iter().enumerate() {
        design_hashes(v, d, &mut hh);
        for &(h, t) in &hh { if (0..65536).contains(&t) { rows.push(((h as u64) << 32) | ((tr as u64) << 16) | t as u64); } }
    }
    peaks.clear(); peaks.shrink_to_fit();
    rows.sort_unstable();
    let mut bucket = vec![0u32; (1 << 24) + 1];
    for &r in &rows { bucket[(r >> 40) as usize + 1] += 1; }
    for i in 1..bucket.len() { bucket[i] += bucket[i - 1]; }
    let ix = DIndex { bucket, rows };
    // posting statistics: how crowded are the words?
    let (mut distinct, mut over, mut over62, mut i) = (0usize, 0usize, 0usize, 0usize);
    while i < ix.rows.len() {
        let h = ix.rows[i] >> 32;
        let mut j = i; while j < ix.rows.len() && ix.rows[j] >> 32 == h { j += 1; }
        distinct += 1; if j - i > 400 { over += j - i; } if j - i > 62 { over62 += j - i; }
        i = j;
    }
    eprintln!("[design] {} rows, {} distinct words, {:.1} per word · rows in words >400: {:.1}% · >62 (≈ >400 at 65k): {:.1}% · built in {:.0} s",
        ix.rows.len(), distinct, ix.rows.len() as f64 / distinct as f64, 100.0 * over as f64 / ix.rows.len() as f64,
        100.0 * over62 as f64 / ix.rows.len() as f64, t0.elapsed().as_secs_f64());
    // 3. the lab's query clips, 9 pitches each — same voting and tie rules as best_match
    let names = read_strings(names_path);
    let qpk = read_peaks(peaks_path);
    let queries = read_strings(queries_path);
    let ratios: Vec<(f64, f64)> = SWEEP.iter().map(|&s| (s, 2f64.powf(-s / 12.0))).collect();
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let t1 = Instant::now();
    let mut results: Vec<(usize, Option<(u32, u32, i32)>, f64)> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
            let (mut sp, mut qh, mut votes, mut mine): (Vec<(i32, i32)>, Vec<(u32, i32)>, Vec<(u64, u32)>, Vec<_>) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            loop {
                let q = next.fetch_add(1, Ordering::Relaxed);
                if q >= qpk.len() { break; }
                let (mut best, mut semi) = (None::<(u32, u32, i32)>, 0.0);
                for &(st, ratio) in &ratios {
                    scaled(&qpk[q], ratio, &mut sp);
                    design_hashes(&sp, d, &mut qh);
                    votes.clear();
                    let mut seq = 0u32;
                    for &(h, t) in &qh {
                        let post = ix.postings(h);
                        if post.is_empty() || post.len() > stop { continue; }
                        for &r in post {
                            let off = (r & 0xffff) as i32 - t;
                            votes.push(((((r >> 16) & 0xffff) << 32) | (off as i64 + (1i64 << 31)) as u64, seq));
                            seq += 1;
                        }
                    }
                    if votes.is_empty() { continue; }
                    votes.sort_unstable();
                    let (mut bt, mut i) = (None::<(u32, u32, i32, u32)>, 0);
                    let mut cur: Option<(u32, u32, i32, u32, u32)> = None;
                    let fin = |c: Option<(u32, u32, i32, u32, u32)>, bt: &mut Option<(u32, u32, i32, u32)>| {
                        if let Some((tid, cnt, off, _, tf)) = c {
                            if bt.map_or(true, |(_, bc, _, bf)| cnt > bc || (cnt == bc && tf < bf)) { *bt = Some((tid, cnt, off, tf)); }
                        }
                    };
                    while i < votes.len() {
                        let key = votes[i].0; let mut j = i;
                        while j < votes.len() && votes[j].0 == key { j += 1; }
                        let (cnt, first, tid) = ((j - i) as u32, votes[i].1, (key >> 32) as u32);
                        let off = ((key & 0xffff_ffff) as i64 - (1i64 << 31)) as i32;
                        match cur {
                            Some((ct, cc, co, cf, tf)) if ct == tid => {
                                let (nc, no, nf) = if cnt > cc || (cnt == cc && first < cf) { (cnt, off, first) } else { (cc, co, cf) };
                                cur = Some((ct, nc, no, nf, tf.min(first)));
                            }
                            _ => { fin(cur, &mut bt); cur = Some((tid, cnt, off, first, first)); }
                        }
                        i = j;
                    }
                    fin(cur, &mut bt);
                    if let Some((t, c, o, _)) = bt { if c > best.map_or(0, |b| b.1) { best = Some((t, c, o)); semi = st; } }
                }
                mine.push((q, best, semi));
            }
            mine
        })).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    results.sort_by_key(|r| r.0);
    let body: Vec<String> = results.iter().map(|(q, b, semi)| {
        let (m, v, o) = b.map_or((String::new(), 0, 0), |(t, v, o)| (names[t as usize].clone(), v, o));
        format!("{}:{{\"match\":{},\"votes\":{},\"offset_frames\":{},\"semitones\":{:?}}}", json_str(&queries[*q]), json_str(&m), v, o, semi)
    }).collect();
    let tag = match d { Design::Pairs => "pairs", Design::Trip => "trip", Design::TripQ => "tripq" };
    let path = format!("{out_dir}/design-{tag}-stop{stop}.json");
    fs::write(&path, format!("{{\"match_seconds_total\":0,\"wall_seconds\":{},\"threads\":{threads},\"results\":{{{}}}}}", t1.elapsed().as_secs_f64(), body.join(","))).expect("write");
    eprintln!("[design] {tag} stop {stop}: {} queries in {:.1} s → {path}", results.len(), t1.elapsed().as_secs_f64());
}

// ── Pilot (2026-10-12): the triplet index ON DISK, read per check ───────────────────────────
// The full catalogue's index (~30–37 GB) won't fit in 16 GB of memory, so a check must read it from
// Bandlab (an SSD on USB: ~0.5 ms a read, sometimes ~14 ms). Layout in <dir>: bucket.u32 (2^24+1
// offsets into rows by the word's top 24 bits — 64 MB, kept in memory) and rows.u64 (word 32 | track
// 16 | time 16, sorted). peaks.idx/peaks.dat keep every recording's peaks so any future design can be
// built without downloading the audio again.
//   fp_match buildtrip <scale dir> <names.json> <out dir>
//   fp_match diskscan  <trip dir> <names.json> [memory|disk] <peaks file>…
fn buildtrip(index: &str, names_path: &str, out_dir: &str) {
    let t0 = Instant::now();
    let peaks = rebuild_peaks(index, names_path);
    fs::create_dir_all(out_dir).expect("out dir");
    {   // the peaks, for future builds: peaks.idx = u64 offset per recording (n+1), peaks.dat = (u16 t, u16 f)
        use std::io::Write;
        let mut idx = Vec::with_capacity((peaks.len() + 1) * 8);
        let mut dat = std::io::BufWriter::new(fs::File::create(format!("{out_dir}/peaks.dat")).unwrap());
        let mut off = 0u64;
        for v in &peaks {
            idx.extend_from_slice(&off.to_le_bytes());
            for &(t, f) in v { dat.write_all(&(t as u16).to_le_bytes()).unwrap(); dat.write_all(&(f as u16).to_le_bytes()).unwrap(); }
            off += v.len() as u64;
        }
        idx.extend_from_slice(&off.to_le_bytes());
        fs::write(format!("{out_dir}/peaks.idx"), idx).unwrap();
        eprintln!("[buildtrip] {off} peaks saved · {:.0} s", t0.elapsed().as_secs_f64());
    }
    let mut hh = Vec::new();
    let mut total = 0usize;
    for v in &peaks { design_hashes(v, Design::TripQ, &mut hh); total += hh.len(); }
    let mut rows: Vec<u64> = Vec::with_capacity(total);
    for (tr, v) in peaks.iter().enumerate() {
        design_hashes(v, Design::TripQ, &mut hh);
        for &(h, t) in &hh { if (0..65536).contains(&t) { rows.push(((h as u64) << 32) | ((tr as u64) << 16) | t as u64); } }
    }
    drop(peaks);
    rows.sort_unstable();
    let mut bucket = vec![0u32; (1 << 24) + 1];
    for &r in &rows { bucket[(r >> 40) as usize + 1] += 1; }
    for i in 1..bucket.len() { bucket[i] += bucket[i - 1]; }
    let mut b = Vec::with_capacity(bucket.len() * 4);
    for x in &bucket { b.extend_from_slice(&x.to_le_bytes()); }
    fs::write(format!("{out_dir}/bucket.u32"), b).unwrap();
    {
        use std::io::Write;
        let mut w = std::io::BufWriter::with_capacity(1 << 24, fs::File::create(format!("{out_dir}/rows.u64")).unwrap());
        for r in &rows { w.write_all(&r.to_le_bytes()).unwrap(); }
    }
    fs::copy(names_path, format!("{out_dir}/names.json")).unwrap();
    eprintln!("[buildtrip] {} rows written ({:.1} GB) · {:.0} s", rows.len(), rows.len() as f64 * 8.0 / 1e9, t0.elapsed().as_secs_f64());
}

// ── The full catalogue's triplet index (2026-10-15) ─────────────────────────────────────────
// buildtrip keeps every row in memory and packs the track in 16 bits; the full catalogue has 65,586
// recordings (> 65,536) and ~3.7 billion rows (~30 GB, the Mac has 16 GB). So buildfull reads the
// peaks store full_catalogue.py writes (peaks.idx · peaks.dat · names.json) and builds in passes, each
// pass one slice of the 2^24 buckets. A row needs only the word's low 8 bits — its bucket already says
// the top 24 — which leaves 40 bits for the track:
//   rows.u64  = word low 8 (bits 56–63) | track (16–55) | time (0–15), sorted within each bucket
//   bucket.u64 = 2^24 + 1 row offsets (a u32 would overflow past 4.29 billion rows)
//   fp_match buildfull <peaks dir> <out dir> [passes, default 32 — ~1 GB of rows per pass] [sample, default 1]
// sample R keeps only the words in_sample(h, R) — 1 in R, every posting of a kept word — for the
// in-memory first step of the two-step check (see TwoStep).
fn buildfull(peaks_dir: &str, out_dir: &str, passes: usize, sample: u32) {
    use std::io::Write;
    let t0 = Instant::now();
    assert!(passes.is_power_of_two() && (2..=1 << 12).contains(&passes), "passes must be a power of two, 2 or more");
    assert!(sample.is_power_of_two(), "sample must be a power of two (1 = every word)");
    let idx: Vec<usize> = fs::read(format!("{peaks_dir}/peaks.idx")).expect("peaks.idx").chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap()) as usize).collect();
    let dat: Vec<u16> = fs::read(format!("{peaks_dir}/peaks.dat")).expect("peaks.dat").chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let names_path = format!("{peaks_dir}/names.json");
    let nt = read_strings(&names_path).len();
    assert_eq!(nt + 1, idx.len(), "names.json and peaks.idx disagree");
    assert_eq!(idx[nt] * 2, dat.len(), "peaks.idx does not end where peaks.dat does");
    assert!(nt < 1 << 17, "the pass key packs the track in 17 bits");
    eprintln!("[buildfull] {nt} recordings · {} peaks read in {:.0} s", dat.len() / 2, t0.elapsed().as_secs_f64());
    fs::create_dir_all(out_dir).expect("out dir");
    let shift = 32 - passes.trailing_zeros();          // a word's pass = its top log2(passes) bits
    let per_pass = (1usize << 24) / passes;            // buckets per pass
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut bucket = vec![0u64; (1 << 24) + 1];
    let mut w = std::io::BufWriter::with_capacity(1 << 24, fs::File::create(format!("{out_dir}/rows.u64")).unwrap());
    let mut total = 0u64;
    for pass in 0..passes {
        let tp = Instant::now();
        let b0 = pass * per_pass;
        let next = AtomicUsize::new(0);
        let parts: Vec<Vec<u64>> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
                let (mut pk, mut hh, mut mine): (Vec<(i32, i32)>, Vec<(u32, i32)>, Vec<u64>) = (Vec::new(), Vec::new(), Vec::new());
                loop {
                    let tr = next.fetch_add(1, Ordering::Relaxed);
                    if tr >= nt { break; }
                    pk.clear();
                    pk.extend((idx[tr]..idx[tr + 1]).map(|k| (dat[2 * k] as i32, dat[2 * k + 1] as i32)));
                    design_hashes(&pk, Design::TripQ, &mut hh);
                    for &(h, t) in &hh {
                        if (h >> shift) as usize != pass || !in_sample(h, sample) || !(0..65536).contains(&t) { continue; }
                        // pass key: bucket within the pass (≤ 23 bits) | word low 8 | track 17 | time 16
                        let bl = ((h >> 8) as usize - b0) as u64;
                        mine.push((bl << 41) | (((h & 0xff) as u64) << 33) | ((tr as u64) << 16) | t as u64);
                    }
                }
                mine
            })).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let mut keys: Vec<u64> = Vec::with_capacity(parts.iter().map(|p| p.len()).sum());
        for p in parts { keys.extend(p); }
        let th = tp.elapsed().as_secs_f64();
        keys.sort_unstable();
        for &k in &keys {
            bucket[b0 + (k >> 41) as usize + 1] += 1;
            let row = (((k >> 33) & 0xff) << 56) | (k & 0x1_ffff_ffff);
            w.write_all(&row.to_le_bytes()).unwrap();
        }
        total += keys.len() as u64;
        eprintln!("[buildfull] pass {}/{passes}: {} rows · words {:.0} s · sort+write {:.0} s · {:.1} GB so far · {:.0} min in",
            pass + 1, keys.len(), th, tp.elapsed().as_secs_f64() - th, total as f64 * 8.0 / 1e9, t0.elapsed().as_secs_f64() / 60.0);
    }
    w.flush().unwrap();
    for i in 1..bucket.len() { bucket[i] += bucket[i - 1]; }
    assert_eq!(bucket[1 << 24], total);
    let mut b = Vec::with_capacity(bucket.len() * 8);
    for x in &bucket { b.extend_from_slice(&x.to_le_bytes()); }
    fs::write(format!("{out_dir}/bucket.u64"), b).unwrap();
    fs::copy(&names_path, format!("{out_dir}/names.json")).unwrap();
    fs::write(format!("{out_dir}/sample.txt"), format!("{sample}\n")).unwrap();
    eprintln!("[buildfull] DONE {total} rows ({:.1} GB) for {nt} recordings · {:.0} min", total as f64 * 8.0 / 1e9, t0.elapsed().as_secs_f64() / 60.0);
}

/// A file of little-endian u64s read straight into one Vec (no second copy: a 3.7 GB sample index
/// would otherwise need 7.4 GB while loading). The Mac is little-endian, like the files.
fn read_u64s_le(path: &str) -> Vec<u64> {
    use std::io::Read;
    let mut f = fs::File::open(path).expect("rows file");
    let n = (f.metadata().unwrap().len() / 8) as usize;
    let mut v = vec![0u64; n];
    let bytes = unsafe { std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut u8, n * 8) };
    f.read_exact(bytes).expect("read rows");
    if cfg!(target_endian = "big") { for x in v.iter_mut() { *x = u64::from_le(*x); } }
    v
}

/// Where a check gets a word's postings from: the rows in memory, or read from the file on disk.
enum RowSource { Memory(Vec<u64>), Disk(fs::File) }

/// `wide`: the buildfull layout (bucket.u64; rows hold the word's low 8 bits and a 40-bit track);
/// otherwise buildtrip's (bucket.u32; rows hold the whole word and a 16-bit track).
struct TripIndex { bucket: Vec<u64>, src: RowSource, wide: bool }

impl TripIndex {
    /// Does row r hold word h's posting — compared as the sort order within a bucket sees it.
    #[inline]
    fn word_key(&self, h: u32) -> u64 { if self.wide { (h & 0xff) as u64 } else { h as u64 } }
    #[inline]
    fn row_word(&self, r: u64) -> u64 { if self.wide { r >> 56 } else { r >> 32 } }
    #[inline]
    fn row_track(&self, r: u64) -> u64 { if self.wide { (r >> 16) & 0xff_ffff_ffff } else { (r >> 16) & 0xffff } }

    fn open(dir: &str, memory: bool) -> TripIndex {
        let wide = std::path::Path::new(&format!("{dir}/bucket.u64")).exists();
        let bucket: Vec<u64> = if wide {
            fs::read(format!("{dir}/bucket.u64")).unwrap().chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect()
        } else {
            fs::read(format!("{dir}/bucket.u32")).unwrap().chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]) as u64).collect()
        };
        let path = format!("{dir}/rows.u64");
        let src = if memory {
            RowSource::Memory(read_u64s_le(&path))
        } else {
            let f = fs::File::open(&path).unwrap();
            #[cfg(target_os = "macos")]
            unsafe { extern "C" { fn fcntl(fd: i32, cmd: i32, ...) -> i32; } use std::os::unix::io::AsRawFd; fcntl(f.as_raw_fd(), 48, 1); } // F_NOCACHE: time the disk, not the Mac's cache
            RowSource::Disk(f)
        };
        TripIndex { bucket, src, wide }
    }
    /// The rows of every bucket the words fall in. Disk: nearby buckets are merged into one read (a gap
    /// under 64 KB costs less than a second read) and the reads run in parallel (an SSD serves many at once).
    fn fetch(&self, words: &[u32]) -> std::collections::HashMap<u32, Vec<u64>> {
        let mut buckets: Vec<u32> = words.iter().map(|h| h >> 8).collect();
        buckets.sort_unstable(); buckets.dedup();
        let mut out = std::collections::HashMap::new();
        match &self.src {
            RowSource::Memory(rows) => {
                for &b in &buckets {
                    let (a, z) = (self.bucket[b as usize] as usize, self.bucket[b as usize + 1] as usize);
                    if a < z { out.insert(b, rows[a..z].to_vec()); }
                }
            }
            RowSource::Disk(f) => {
                use std::os::unix::fs::FileExt;
                let mut spans: Vec<(usize, usize, Vec<u32>)> = Vec::new(); // row range, buckets in it
                for &b in &buckets {
                    let (a, z) = (self.bucket[b as usize] as usize, self.bucket[b as usize + 1] as usize);
                    if a == z { continue; }
                    match spans.last_mut() {
                        Some(s) if (a - s.1) * 8 < 65_536 => { s.1 = z; s.2.push(b); }
                        _ => spans.push((a, z, vec![b])),
                    }
                }
                let next = AtomicUsize::new(0);
                let got: Vec<(u32, Vec<u64>)> = std::thread::scope(|sc| {
                    let hs: Vec<_> = (0..24).map(|_| sc.spawn(|| {
                        let mut mine = Vec::new();
                        loop {
                            let i = next.fetch_add(1, Ordering::Relaxed);
                            if i >= spans.len() { break; }
                            let (a, z, bs) = &spans[i];
                            let mut buf = vec![0u8; (z - a) * 8];
                            f.read_exact_at(&mut buf, (*a as u64) * 8).unwrap();
                            for &b in bs {
                                let (ba, bz) = (self.bucket[b as usize] as usize, self.bucket[b as usize + 1] as usize);
                                mine.push((b, buf[(ba - a) * 8..(bz - a) * 8].chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect()));
                            }
                        }
                        mine
                    })).collect();
                    hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
                });
                out.extend(got);
            }
        }
        out
    }
}

fn trip_scan_pitch(pk: &[(i32, i32)], ratio: f64, semis: f64, ix: &TripIndex) -> Vec<Stretch> {
    let (mut sp, mut hh) = (Vec::new(), Vec::new());
    scaled(pk, ratio, &mut sp);
    design_hashes(&sp, Design::TripQ, &mut hh);
    let words: Vec<u32> = hh.iter().map(|x| x.0).collect();
    let rows = ix.fetch(&words);
    let mut v: Vec<u64> = Vec::new();
    for &(h, t) in &hh {
        if !(0..=MAX_FRAMES).contains(&t) { continue; }
        let Some(bucket) = rows.get(&(h >> 8)) else { continue };
        let wk = ix.word_key(h);
        let lo = bucket.partition_point(|&r| ix.row_word(r) < wk);
        let hi = bucket.partition_point(|&r| ix.row_word(r) <= wk);
        if lo == hi || hi - lo > stop_postings() { continue; }
        for &r in &bucket[lo..hi] {
            let off = (r & 0xffff) as i32 - t + 65_536;
            v.push((ix.row_track(r) << 33) | ((off as u64) << 16) | t as u64);
        }
    }
    stretches(&mut v, semis)
}

/// Votes — track << 33 | (offset + 65536) << 16 | query frame — into the stretches that pass the bar:
/// ≥ MIN votes at one (track, offset), no pause over GAP, and ≥ MIN of them inside WINDOW.
fn stretches(v: &mut Vec<u64>, semis: f64) -> Vec<Stretch> {
    v.sort_unstable();
    let (mut out, mn, mut i) = (Vec::new(), min_votes(), 0);
    while i < v.len() {
        let key = v[i] >> 16;
        let mut j = i;
        while j < v.len() && v[j] >> 16 == key { j += 1; }
        if (j - i) as u32 >= mn {
            let (track, off) = ((key >> 17) as u32, (key & 0x1_ffff) as i32 - 65_536);
            let mut k = i;
            while k < j {
                let (mut e, start) = (k, (v[k] & 0xffff) as u32);
                while e + 1 < j && ((v[e + 1] & 0xffff) as u32) - ((v[e] & 0xffff) as u32) <= GAP { e += 1; }
                let (mut dense, mut lo) = (0u32, k);
                for hi in k..=e {
                    while ((v[hi] & 0xffff) as u32) - ((v[lo] & 0xffff) as u32) > WINDOW { lo += 1; }
                    dense = dense.max((hi - lo + 1) as u32);
                }
                let votes = (e - k + 1) as u32;
                if votes >= mn && dense >= mn { out.push(Stretch { track, off, q_start: start, q_end: (v[e] & 0xffff) as u32, votes, semis }); }
                k = e + 1;
            }
        }
        i = j;
    }
    out
}

/// scan_song for the triplet index: 9 pitches one after another (each already reads in parallel).
fn trip_scan_song(pk: &[(i32, i32)], ix: &TripIndex) -> Vec<Stretch> {
    merge_stretches(SWEEP.iter().flat_map(|&s| trip_scan_pitch(pk, 2f64.powf(-s / 12.0), s, ix)).collect())
}

/// The same place found at several pitches or offsets: keep the strongest; neighbouring offsets of one
/// track that touch in the suspect become one stretch (as scan_song).
fn merge_stretches(mut all: Vec<Stretch>) -> Vec<Stretch> {
    all.sort_by(|a, b| b.votes.cmp(&a.votes).then(a.semis.abs().partial_cmp(&b.semis.abs()).unwrap()));
    let mut kept: Vec<Stretch> = Vec::new();
    for s in all { if !kept.iter().any(|k| k.track == s.track && s.q_start <= k.q_end && k.q_start <= s.q_end) { kept.push(s); } }
    kept.sort_by_key(|s| (s.track, s.q_start));
    let mut merged: Vec<Stretch> = Vec::new();
    for s in kept {
        if let Some(m) = merged.last_mut() {
            if m.track == s.track && (m.off - s.off).abs() <= 6 * 43 && s.q_start <= m.q_end + GAP {
                m.q_end = m.q_end.max(s.q_end);
                if s.votes > m.votes { m.off = s.off; m.semis = s.semis; }
                m.votes += s.votes;
                continue;
            }
        }
        merged.push(s);
    }
    merged.sort_by(|a, b| b.votes.cmp(&a.votes));
    merged
}

// ── Two-step check (2026-10-15): the full catalogue in seconds, not minutes ─────────────────
// Bandlab serves ~2,700 small reads a second however many are asked at once, and a whole song at 9
// pitches touches ~670k buckets of the 30 GB index — 4 minutes. Instead:
//   1. a SAMPLE index in memory — 1 in R words (all their postings), ~3.7 GB at R = 8 — names the
//      candidate recordings: any (track, offset) with ≥ K sampled votes;
//   2. each candidate is checked against ALL its words, rebuilt from its peaks (one read each from
//      the peaks store), with exactly the full index's rules — the same stop words (the full index's
//      words in more than FP_STOP postings, listed once by `stopwords`), the same stretches.
// So a recording that step 1 names gets exactly the answer the full on-disk scan gives; only one
// that step 1 misses is lost — measured with `twoeval` against the full scan.
//   fp_match stopwords <full index dir> <out stop.u32> [stop, default FP_STOP / 400]
//   fp_match twoeval <sample dir> <stop.u32> <peaks dir> <queries peaks.bin> <queries.json> <out.tsv> [K | full]
//   fp_match serve2 <sample dir> <stop.u32> <peaks dir>

/// Is word h in the 1-in-R sample? Its low bits — mix32 spreads them evenly.
#[inline]
fn in_sample(h: u32, r: u32) -> bool { h & (r - 1) == 0 }

fn stopwords(dir: &str, out_path: &str, stop: usize) {
    use std::io::Read;
    let t0 = Instant::now();
    let bucket: Vec<u64> = fs::read(format!("{dir}/bucket.u64")).expect("bucket.u64").chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
    let mut f = std::io::BufReader::with_capacity(1 << 26, fs::File::open(format!("{dir}/rows.u64")).unwrap());
    let mut words: Vec<u32> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    for b in 0..(1usize << 24) {
        let n = (bucket[b + 1] - bucket[b]) as usize;
        buf.resize(n * 8, 0);
        f.read_exact(&mut buf).unwrap();
        let mut i = 0;
        while i < n {
            let lo8 = buf[i * 8 + 7]; // the row's top byte = the word's low 8 bits
            let mut j = i;
            while j < n && buf[j * 8 + 7] == lo8 { j += 1; }
            if j - i > stop { words.push(((b as u32) << 8) | lo8 as u32); }
            i = j;
        }
        if b % (1 << 21) == 0 && b > 0 { eprintln!("[stopwords] {}/8 · {:.0} s", b >> 21, t0.elapsed().as_secs_f64()); }
    }
    let mut b = Vec::with_capacity(words.len() * 4);
    for w in &words { b.extend_from_slice(&w.to_le_bytes()); }
    fs::write(out_path, b).unwrap();
    eprintln!("[stopwords] {} words in more than {stop} postings · {:.0} s", words.len(), t0.elapsed().as_secs_f64());
}

struct TwoStep { sample: TripIndex, r: u32, stop: Vec<u32>, pidx: Vec<u64>, pdat: fs::File, k: u32 }

impl TwoStep {
    fn open(sample_dir: &str, stop_path: &str, peaks_dir: &str, k: u32) -> TwoStep {
        let r: u32 = fs::read_to_string(format!("{sample_dir}/sample.txt")).map(|s| s.trim().parse().unwrap()).unwrap_or(1);
        let stop = read_u32s(std::path::Path::new(stop_path)); // sorted: written bucket by bucket
        let pidx: Vec<u64> = fs::read(format!("{peaks_dir}/peaks.idx")).expect("peaks.idx").chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        let pdat = fs::File::open(format!("{peaks_dir}/peaks.dat")).expect("peaks.dat");
        TwoStep { sample: TripIndex::open(sample_dir, true), r, stop, pidx, pdat, k }
    }
    fn peaks(&self, tr: usize) -> Vec<(i32, i32)> {
        use std::os::unix::fs::FileExt;
        let (a, z) = (self.pidx[tr] as usize, self.pidx[tr + 1] as usize);
        let mut buf = vec![0u8; (z - a) * 4];
        self.pdat.read_exact_at(&mut buf, a as u64 * 4).unwrap();
        buf.chunks_exact(4).map(|c| (u16::from_le_bytes([c[0], c[1]]) as i32, u16::from_le_bytes([c[2], c[3]]) as i32)).collect()
    }
}

/// Returns the stretches and how many candidates step 1 named.
fn two_scan_song(pk: &[(i32, i32)], ts: &TwoStep, threads: usize) -> (Vec<Stretch>, usize) {
    // every pitch's query words, minus the full index's stop words, sorted by word for the join
    let mut qw: Vec<(f64, Vec<(u32, i32)>)> = Vec::new();
    let mut sp = Vec::new();
    for &s in &SWEEP {
        let mut hh = Vec::new();
        scaled(pk, 2f64.powf(-s / 12.0), &mut sp);
        design_hashes(&sp, Design::TripQ, &mut hh);
        hh.retain(|&(h, t)| (0..=MAX_FRAMES).contains(&t) && ts.stop.binary_search(&h).is_err());
        hh.sort_unstable();
        qw.push((s, hh));
    }
    // step 1: candidates from the in-memory sample
    let mut cand: Vec<u32> = Vec::new();
    for (_, hh) in &qw {
        let words: Vec<u32> = hh.iter().filter(|x| in_sample(x.0, ts.r)).map(|x| x.0).collect();
        let rows = ts.sample.fetch(&words);
        let mut v: Vec<u64> = Vec::new();
        for &(h, t) in hh.iter().filter(|x| in_sample(x.0, ts.r)) {
            let Some(bucket) = rows.get(&(h >> 8)) else { continue };
            let wk = ts.sample.word_key(h);
            let lo = bucket.partition_point(|&r| ts.sample.row_word(r) < wk);
            let hi = bucket.partition_point(|&r| ts.sample.row_word(r) <= wk);
            for &r in &bucket[lo..hi] {
                v.push((ts.sample.row_track(r) << 17) | ((r & 0xffff) as i32 - t + 65_536) as u64);
            }
        }
        v.sort_unstable();
        let mut i = 0;
        while i < v.len() {
            let mut j = i;
            while j < v.len() && v[j] == v[i] { j += 1; }
            if (j - i) as u32 >= ts.k { cand.push((v[i] >> 17) as u32); }
            i = j;
        }
    }
    cand.sort_unstable(); cand.dedup();
    // step 2: each candidate against all its words, at every pitch
    let next = AtomicUsize::new(0);
    let found: Vec<Stretch> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads.max(1)).map(|_| sc.spawn(|| {
            let (mut mine, mut cw) = (Vec::new(), Vec::new());
            loop {
                let c = next.fetch_add(1, Ordering::Relaxed);
                if c >= cand.len() { break; }
                let tr = cand[c];
                design_hashes(&ts.peaks(tr as usize), Design::TripQ, &mut cw);
                cw.retain(|&(_, t)| (0..65536).contains(&t));
                cw.sort_unstable();
                for (s, hh) in &qw {
                    let mut v: Vec<u64> = Vec::new();
                    let (mut a, mut b) = (0, 0);
                    while a < hh.len() && b < cw.len() {
                        let (ha, hb) = (hh[a].0, cw[b].0);
                        if ha < hb { a += 1; } else if hb < ha { b += 1; } else {
                            let b_end = cw[b..].partition_point(|x| x.0 == ha) + b;
                            while a < hh.len() && hh[a].0 == ha {
                                let t = hh[a].1;
                                for &(_, ti) in &cw[b..b_end] { v.push(((tr as u64) << 33) | ((ti - t + 65_536) as u64) << 16 | t as u64); }
                                a += 1;
                            }
                            b = b_end;
                        }
                    }
                    mine.extend(stretches(&mut v, *s));
                }
            }
            mine
        })).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    (merge_stretches(found), cand.len())
}

/// Lab clips through the two-step check (K = a number) or through the full scan of the same index
/// (`full`, for a sample dir built with sample 1) → one line per clip: name · candidates · ms · matches.
fn twoeval(sample_dir: &str, stop_path: &str, peaks_dir: &str, qpeaks: &str, qnames: &str, out_path: &str, mode: &str) {
    let t0 = Instant::now();
    let k = mode.parse().unwrap_or(0);
    let ts = TwoStep::open(sample_dir, stop_path, peaks_dir, k);
    let names = read_strings(&format!("{peaks_dir}/names.json"));
    let (qpk, qn) = (read_peaks(qpeaks), read_strings(qnames));
    eprintln!("[twoeval] sample 1/{} loaded, {} stop words, {} clips · {:.0} s", ts.r, ts.stop.len(), qpk.len(), t0.elapsed().as_secs_f64());
    let next = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut lines: Vec<(usize, String)> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads).map(|_| sc.spawn(|| {
            let mut mine = Vec::new();
            loop {
                let q = next.fetch_add(1, Ordering::Relaxed);
                if q >= qpk.len() { break; }
                let t = Instant::now();
                let (found, nc) = if k == 0 { (trip_scan_song(&qpk[q], &ts.sample), 0) } else { two_scan_song(&qpk[q], &ts, 1) };
                let m: Vec<String> = found.iter().take(5).map(|s| format!("{}:{}:{}", names[s.track as usize], s.votes, s.semis)).collect();
                mine.push((q, format!("{}\t{}\t{}\t{}", qn[q], nc, t.elapsed().as_millis(), m.join(" "))));
            }
            mine
        })).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    lines.sort_by_key(|l| l.0);
    fs::write(out_path, lines.iter().map(|l| l.1.as_str()).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    eprintln!("[twoeval] {mode}: {} clips in {:.0} s → {out_path}", lines.len(), t0.elapsed().as_secs_f64());
}

/// serve for the two-step check: the same stdin/stdout protocol as `serve`.
fn serve2(sample_dir: &str, stop_path: &str, peaks_dir: &str) {
    use std::io::{BufRead, Write};
    let t0 = Instant::now();
    let k = std::env::var("FP_CAND_VOTES").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
    let ts = TwoStep::open(sample_dir, stop_path, peaks_dir, k);
    let names = read_strings(&format!("{peaks_dir}/names.json"));
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    eprintln!("[fp_match] two-step: sample 1/{}, {} tracks loaded in {:.1} s", ts.r, names.len(), t0.elapsed().as_secs_f64());
    let fr = |f: f64| (f * 256.0 / 11025.0 * 100.0).round() / 100.0;
    let mut out = std::io::stdout().lock();
    writeln!(out, "{{\"ready\":true,\"tracks\":{},\"rows\":0}}", names.len()).unwrap();
    out.flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        let (id, path) = match line.split_once('\t') { Some(x) => x, None => continue };
        let t = Instant::now();
        let reply = match std::panic::catch_unwind(|| read_peaks(path)) {
            Ok(mut p) if p.len() == 1 => {
                let pk = p.remove(0);
                let (found, nc) = two_scan_song(&pk, &ts, threads);
                let items: Vec<String> = found.iter().take(50).map(|s| format!(
                    "{{\"file\":{},\"votes\":{},\"semitones\":{:?},\"q_start\":{},\"q_end\":{},\"ref_start\":{}}}",
                    json_str(names.get(s.track as usize).map(|n| n.as_str()).unwrap_or("")), s.votes, s.semis,
                    fr(s.q_start as f64), fr(s.q_end as f64), fr(s.q_start as f64 + s.off as f64))).collect();
                format!("{{\"id\":{},\"ok\":true,\"peaks\":{},\"candidates\":{nc},\"ms\":{},\"matches\":[{}]}}", json_str(id), pk.len(), t.elapsed().as_millis(), items.join(","))
            }
            _ => format!("{{\"id\":{},\"ok\":false,\"error\":\"unreadable peaks file\"}}", json_str(id)),
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}

fn diskscan(dir: &str, names_path: &str, memory: bool, files: &[String]) {
    let t0 = Instant::now();
    let ix = TripIndex::open(dir, memory);
    let names = read_strings(names_path);
    eprintln!("[diskscan] {} index open in {:.1} s", if memory { "in-memory" } else { "on-disk" }, t0.elapsed().as_secs_f64());
    let fr = |f: f64| (f * 256.0 / 11025.0 * 100.0).round() / 100.0;
    for path in files {
        let mut p = read_peaks(path);
        if p.len() != 1 { eprintln!("bad peaks file {path}"); continue; }
        let pk = p.remove(0);
        let t = Instant::now();
        let found = trip_scan_song(&pk, &ix);
        let items: Vec<String> = found.iter().take(5).map(|s| format!("{}|{}|{:+}|{}-{}|{}", names.get(s.track as usize).map(|n| n.as_str()).unwrap_or(""),
            s.votes, s.semis, fr(s.q_start as f64), fr(s.q_end as f64), fr(s.q_start as f64 + s.off as f64))).collect();
        println!("{}\t{:.2}s\t{}", path.rsplit('/').next().unwrap_or(path), t.elapsed().as_secs_f64(), items.join("  ;  "));
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.get(1).map(|s| s.as_str()) == Some("buildtrip") && a.len() >= 5 { buildtrip(&a[2], &a[3], &a[4]); return; }
    if a.get(1).map(|s| s.as_str()) == Some("stopwords") && a.len() >= 4 {
        stopwords(&a[2], &a[3], a.get(4).and_then(|s| s.parse().ok()).unwrap_or_else(stop_postings));
        return;
    }
    if a.get(1).map(|s| s.as_str()) == Some("twoeval") && a.len() >= 8 {
        twoeval(&a[2], &a[3], &a[4], &a[5], &a[6], &a[7], a.get(8).map(|s| s.as_str()).unwrap_or("2"));
        return;
    }
    if a.get(1).map(|s| s.as_str()) == Some("serve2") && a.len() >= 5 { serve2(&a[2], &a[3], &a[4]); return; }
    if a.get(1).map(|s| s.as_str()) == Some("buildfull") && a.len() >= 4 {
        buildfull(&a[2], &a[3], a.get(4).and_then(|s| s.parse().ok()).unwrap_or(32), a.get(5).and_then(|s| s.parse().ok()).unwrap_or(1));
        return;
    }
    if a.get(1).map(|s| s.as_str()) == Some("diskscan") && a.len() >= 6 { diskscan(&a[2], &a[3], a[4] == "memory", &a[5..]); return; }
    if a.get(1).map(|s| s.as_str()) == Some("design") && a.len() >= 8 {
        let d = match a[7].as_str() { "trip" => Design::Trip, "tripq" => Design::TripQ, _ => Design::Pairs };
        let stop = a.get(8).and_then(|s| s.parse().ok()).unwrap_or(400);
        design_test(&a[2], &a[3], &a[4], &a[5], &a[6], d, stop);
        return;
    }
    if a.get(1).map(|s| s.as_str()) == Some("selfscan") && a.len() >= 5 {
        let th = a.get(5).and_then(|s| s.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
        selfscan(&a[2], &a[3], &a[4], th);
        return;
    }
    if a.get(1).map(|s| s.as_str()) == Some("serve") && a.len() >= 4 {
        serve(&a[2], &a[3]);
        return;
    }
    if a.len() < 6 {
        eprintln!("fp_match <index.rows> <names.json> <peaks.bin> <queries.json> <out.json> [threads]");
        std::process::exit(2);
    }
    let t0 = Instant::now();
    let ix = load_index(&a[1]);
    let names = read_strings(&a[2]);
    let peaks = read_peaks(&a[3]);
    let queries = read_strings(&a[4]);
    assert_eq!(peaks.len(), queries.len(), "one peak list per query");
    let threads = a.get(6).and_then(|s| s.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    eprintln!("loaded {} rows, {} tracks, {} queries in {:.2} s", ix.track.len(), names.len(), queries.len(), t0.elapsed().as_secs_f64());

    let ratios: Vec<(f64, f64)> = SWEEP.iter().map(|&s| (s, 2f64.powf(-s / 12.0))).collect();
    let next = AtomicUsize::new(0);
    let t1 = Instant::now();
    let mut results: Vec<(usize, Option<(u32, u32, i32)>, f64, f64)> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                sc.spawn(|| {
                    let (mut sp, mut hh, mut votes, mut mine) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
                    loop {
                        let q = next.fetch_add(1, Ordering::Relaxed);
                        if q >= peaks.len() {
                            break;
                        }
                        let s = Instant::now();
                        let (mut best, mut semi) = (None::<(u32, u32, i32)>, 0.0);
                        for &(st, ratio) in &ratios {
                            scaled(&peaks[q], ratio, &mut sp);
                            hashes(&sp, &mut hh);
                            if let Some(r) = best_match(&hh, &ix, &mut votes) {
                                if r.1 > best.map_or(0, |b| b.1) {
                                    best = Some(r);
                                    semi = st;
                                }
                            }
                        }
                        mine.push((q, best, semi, s.elapsed().as_secs_f64()));
                    }
                    mine
                })
            })
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let wall = t1.elapsed().as_secs_f64();
    results.sort_by_key(|r| r.0);
    let cpu: f64 = results.iter().map(|r| r.3).sum();
    let body: Vec<String> = results
        .iter()
        .map(|(q, b, semi, _)| {
            let (m, v, o) = b.map_or((String::new(), 0, 0), |(t, v, o)| (names[t as usize].clone(), v, o));
            format!("{}:{{\"match\":{},\"votes\":{},\"offset_frames\":{},\"semitones\":{:?}}}", json_str(&queries[*q]), json_str(&m), v, o, semi)
        })
        .collect();
    fs::write(&a[5], format!("{{\"match_seconds_total\":{cpu},\"wall_seconds\":{wall},\"threads\":{threads},\"results\":{{{}}}}}", body.join(","))).expect("write");
    eprintln!("matched {} queries: {:.2} s wall on {} threads, {:.1} ms CPU per query", results.len(), wall, threads, cpu / results.len() as f64 * 1000.0);
}
