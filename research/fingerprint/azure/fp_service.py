#!/usr/bin/env python3
"""The Check Audio engine as a small private web service, for GalloIngest (Ian, 2026-11-10).

Runs on the Azure fingerprint server behind Caddy (HTTPS). Every request needs the shared token.
  GET  /health            -> {ok, state: loading|ready, tracks}
  POST /check?ext=.mp3    (body = the audio) -> {ok, seconds, scanned, tracks, ms, matches}
One check at a time: the matcher already uses every CPU, so more at once would only slow each other down.
Audio is deleted as soon as its check ends.
"""
import hmac, json, os, re, shutil, subprocess, sys, tempfile, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOME = os.path.expanduser("~")
LAB, CODE = f"{HOME}/fp-lab", f"{HOME}/code"
BIN, PEAKS = f"{CODE}/fp-rust/target/release/fp_match", f"{CODE}/peaks_cli.py"
TOKEN = os.environ["FP_SERVER_TOKEN"].encode()
MAX_BYTES, MAX_SECONDS = 300 * 1024 * 1024, 1200

status = {"state": "loading", "tracks": None}
check_lock = threading.Lock()
matcher = subprocess.Popen([BIN, "serve2", f"{LAB}/full-sample8", f"{LAB}/full-index/stop.u32", f"{LAB}/full/clean"],
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)


def die(reason):
    print(reason, file=sys.stderr, flush=True)
    os._exit(1)  # systemd starts the service again


def wait_ready():
    line = matcher.stdout.readline()
    if not line:
        die("matcher exited while loading")
    status.update(state="ready", tracks=json.loads(line).get("tracks"))
    print(f"ready: {status['tracks']} recordings", flush=True)


def match(peaks_file):
    with check_lock:
        matcher.stdin.write(f"{uuid.uuid4()}\t{peaks_file}\n")
        matcher.stdin.flush()
        line = matcher.stdout.readline()
    if not line:
        die("matcher stopped")
    return json.loads(line)


class Handler(BaseHTTPRequestHandler):
    server_version, sys_version = "fp", ""

    def log_message(self, *_):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def authorised(self):
        given = self.headers.get("Authorization", "").removeprefix("Bearer ").encode()
        if hmac.compare_digest(given, TOKEN):
            return True
        self.reply(401, {"ok": False, "error": "Not authorised."})
        return False

    def do_GET(self):
        if not self.authorised():
            return
        if urlparse(self.path).path != "/health":
            return self.reply(404, {"ok": False, "error": "Not found."})
        self.reply(200, {"ok": True, **status})

    def do_POST(self):
        if not self.authorised():
            return
        url = urlparse(self.path)
        if url.path != "/check":
            return self.reply(404, {"ok": False, "error": "Not found."})
        if status["state"] != "ready":
            return self.reply(503, {"ok": False, "error": "The fingerprints are still loading."})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.reply(411, {"ok": False, "error": "Length required."})
        if length <= 0 or length > MAX_BYTES:
            return self.reply(413, {"ok": False, "error": "That file is empty or over 300 MB."})
        ext = parse_qs(url.query).get("ext", [".audio"])[0].lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
            ext = ".audio"
        work = tempfile.mkdtemp(prefix="fp-")
        try:
            audio, peaks_file = os.path.join(work, f"in{ext}"), os.path.join(work, "peaks.bin")
            left = length
            with open(audio, "wb") as f:
                while left:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        return self.reply(400, {"ok": False, "error": "The upload stopped early."})
                    f.write(chunk)
                    left -= len(chunk)
            run = subprocess.run([sys.executable, PEAKS, audio, peaks_file, str(MAX_SECONDS)], capture_output=True, text=True, timeout=300)
            if run.returncode != 0:
                return self.reply(422, {"ok": False, "error": "That file could not be read as audio."})
            meta = json.loads(run.stdout)
            if meta["seconds"] < 3:
                return self.reply(422, {"ok": False, "error": "That audio is shorter than 3 seconds, too short to check."})
            found = match(peaks_file)
            if not found.get("ok"):
                return self.reply(500, {"ok": False, "error": found.get("error") or "The matcher could not read the audio."})
            self.reply(200, {"ok": True, "seconds": meta["seconds"], "scanned": meta["scanned"], "tracks": status["tracks"],
                             "ms": found.get("ms"), "matches": found.get("matches", [])})
        except subprocess.TimeoutExpired:
            self.reply(504, {"ok": False, "error": "Reading that audio took too long."})
        finally:
            shutil.rmtree(work, ignore_errors=True)


threading.Thread(target=wait_ready, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
