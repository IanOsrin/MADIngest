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

fn main() {
    let a: Vec<String> = std::env::args().collect();
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
