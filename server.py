#!/usr/bin/env python3
"""Local AI Character Generator – tiny stdlib-only backend.

Serves the static UI, proxies generation to the local llama.cpp server
(OpenAI-compatible API) and stores saved characters in data/characters.json.

    python3 server.py            # http://127.0.0.1:8765
Env: CG_PORT, CG_HOST, LLAMA_URL (default http://127.0.0.1:8081),
     LLAMA_API_KEY / LLAMA_API_KEY_FILE (llama-server --api-key; default ~/.config/llama/api-key if present)
Public mode (CG_PUBLIC=1, for hosting on the internet):
     - saved characters live only in the visitor's browser (server storage disabled),
     - /api/status does not touch llama.cpp (the model may be started on demand - polling would keep it awake),
     - rate limit per client IP (CG_RATE_LIMIT, default 3/3600 = 3 per hour) and per day (CG_DAILY_LIMIT, 40),
     - no internal addresses in messages.
"""

import json
import mimetypes
import os
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from prompts import OUTPUT_SCHEMA, build_messages

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_FILE = ROOT / "data" / "characters.json"

LLAMA_URL = os.environ.get("LLAMA_URL", "http://127.0.0.1:8081").rstrip("/")
HOST = os.environ.get("CG_HOST", "127.0.0.1")
PORT = int(os.environ.get("CG_PORT", "8765"))


def _read_key() -> str:
    if os.environ.get("LLAMA_API_KEY"):
        return os.environ["LLAMA_API_KEY"].strip()
    path = Path(os.environ.get("LLAMA_API_KEY_FILE") or Path.home() / ".config" / "llama" / "api-key")
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


LLAMA_API_KEY = _read_key()
PUBLIC = os.environ.get("CG_PUBLIC") == "1"
_rl_n, _rl_window = (int(x) for x in os.environ.get("CG_RATE_LIMIT", "3/3600").split("/"))
DAILY_LIMIT = int(os.environ.get("CG_DAILY_LIMIT", "40"))

TEMPERATURE = 0.8
TOP_P = 0.95
MAX_TOKENS = 7000
CONNECT_TIMEOUT = 5
READ_TIMEOUT = 180          # max silence between streamed chunks
WAKE_TIMEOUT = 150          # first request may start the model on demand (systemd socket activation)
OFFLINE_CACHE = 120         # public mode: remember a failed connection this long
TOTAL_TIMEOUT = 900         # hard cap for one generation

MSG_UNREACHABLE = ("Nie udało się połączyć z lokalnym Gemma 4 ({url}). "
                   "Sprawdź, czy llama-start.sh jest uruchomiony.")
MSG_PUBLIC_OFFLINE = ("Model jest teraz niedostępny – działa na komputerze autora, "
                      "który jest pewnie wyłączony. Spróbuj później.")

generation_lock = threading.Lock()
data_lock = threading.Lock()


class LlamaError(Exception):
    pass


# --------------------------------------------------------------------------- llama.cpp

def _headers() -> dict:
    h = {"Content-Type": "application/json"}
    if LLAMA_API_KEY:
        h["Authorization"] = f"Bearer {LLAMA_API_KEY}"
    return h


_last_offline = 0.0


def public_status() -> dict:
    """Public mode: never contact llama.cpp just for status (it would wake the model up)."""
    if time.time() - _last_offline < OFFLINE_CACHE:
        return {"ok": False, "public": True, "error": MSG_PUBLIC_OFFLINE}
    return {"ok": True, "public": True, "sleeping": True, "model": "Gemma 4"}


def llama_status(timeout: float = CONNECT_TIMEOUT) -> dict:
    global _last_offline
    st = _llama_status(timeout)
    if PUBLIC:
        st.pop("llama_url", None)
        if not st["ok"]:
            _last_offline = time.time()
            st["error"] = MSG_PUBLIC_OFFLINE
    return st


def _llama_status(timeout: float) -> dict:
    try:
        req = urllib.request.Request(f"{LLAMA_URL}/v1/models", headers=_headers())
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        models = data.get("data") or []
        m = models[0] if models else {}
        return {"ok": True, "model": m.get("id", "?"), "n_ctx": (m.get("meta") or {}).get("n_ctx"),
                "llama_url": LLAMA_URL}
    except urllib.error.HTTPError as e:
        # 503 while the model is still loading
        msg = "Model się ładuje…" if e.code == 503 else f"Serwer LLM zwrócił błąd HTTP {e.code}."
        return {"ok": False, "loading": e.code == 503, "error": msg, "llama_url": LLAMA_URL}
    except Exception:
        return {"ok": False, "error": MSG_UNREACHABLE.format(url=LLAMA_URL), "llama_url": LLAMA_URL}


def _open_completion(messages: list, max_tokens: int, use_schema: bool):
    body = {
        "messages": messages,
        "temperature": TEMPERATURE,
        "top_p": TOP_P,
        "max_tokens": max_tokens,
        "stream": True,
        # Gemma 4 thinks by default; reasoning would eat the token budget.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if use_schema:
        body["response_format"] = {"type": "json_schema",
                                   "json_schema": {"name": "character", "strict": True, "schema": OUTPUT_SCHEMA}}
    else:
        body["response_format"] = {"type": "json_object"}
    req = urllib.request.Request(f"{LLAMA_URL}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers=_headers(), method="POST")
    return urllib.request.urlopen(req, timeout=READ_TIMEOUT)


def stream_completion(messages: list, on_progress):
    """Yields nothing; returns (text, finish_reason). Calls on_progress(tokens, chars)."""
    status = llama_status(timeout=WAKE_TIMEOUT)
    if not status["ok"]:
        raise LlamaError(status["error"])
    n_ctx = status.get("n_ctx") or 8192
    max_tokens = max(1024, min(MAX_TOKENS, n_ctx - 3000))

    resp = None
    for use_schema in (True, False):
        try:
            resp = _open_completion(messages, max_tokens, use_schema)
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:300]
            if e.code == 400 and use_schema:
                continue  # server without json_schema support – fall back
            if e.code == 400 and "context" in detail.lower():
                raise LlamaError("Opis jest za długi dla kontekstu modelu. Skróć dodatkowy opis.")
            raise LlamaError(f"Serwer LLM zwrócił błąd HTTP {e.code}: {detail}")
        except (urllib.error.URLError, ConnectionError, socket.timeout, TimeoutError):
            raise LlamaError(MSG_PUBLIC_OFFLINE if PUBLIC else MSG_UNREACHABLE.format(url=LLAMA_URL))

    parts, tokens, finish = [], 0, None
    started = last = time.monotonic()
    try:
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if "error" in chunk:
                    raise LlamaError(f"Błąd modelu: {chunk['error']}")
                for ch in chunk.get("choices") or []:
                    delta = ch.get("delta") or {}
                    if delta.get("content"):
                        parts.append(delta["content"])
                        tokens += 1
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
                now = time.monotonic()
                if now - started > TOTAL_TIMEOUT:
                    raise LlamaError("Przekroczono limit czasu generowania.")
                if now - last > 0.4:
                    on_progress(tokens, sum(map(len, parts)))
                    last = now
    except (socket.timeout, TimeoutError):
        raise LlamaError("Model przestał odpowiadać (timeout). Spróbuj ponownie.")
    except (urllib.error.URLError, ConnectionError) as e:
        raise LlamaError(f"Połączenie z modelem zostało przerwane: {e}")
    on_progress(tokens, sum(map(len, parts)))
    return "".join(parts), finish


# --------------------------------------------------------------------------- parsing

def _repair_truncated_json(text: str) -> str | None:
    """Closes open strings/containers of a JSON document cut off mid-way."""
    start = text.find("{")
    if start < 0:
        return None
    s = text[start:]
    stack, in_str, esc = [], False, False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    out = s + ('"' if in_str else "")
    out = out.rstrip().rstrip(",")
    if out.endswith(":"):
        out += '""'
    return out + "".join(reversed(stack))


def parse_character(text: str) -> tuple[dict | None, bool]:
    """Returns (character, truncated). None if not parseable."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("{"):] if "{" in text else text
    try:
        obj = json.loads(text)
        return (obj, False) if isinstance(obj, dict) else (None, False)
    except json.JSONDecodeError:
        pass
    a, b = text.find("{"), text.rfind("}")
    if a >= 0 and b > a:
        try:
            obj = json.loads(text[a:b + 1])
            if isinstance(obj, dict):
                return obj, False
        except json.JSONDecodeError:
            pass
    repaired = _repair_truncated_json(text)
    if repaired:
        # a dangling key without value ("abc": "x", "de) may still break – trim back to last comma
        for _ in range(20):
            try:
                obj = json.loads(repaired)
                return (obj, True) if isinstance(obj, dict) else (None, True)
            except json.JSONDecodeError:
                cut = repaired.rstrip("]}\"").rfind(",")
                if cut <= 0:
                    break
                repaired = _repair_truncated_json(repaired[:cut])
                if not repaired:
                    break
    return None, False


def normalize_character(obj: dict) -> dict:
    """Fill missing keys from the schema so the UI never crashes on partial data."""
    def fill(schema, value):
        t = schema.get("type")
        if t == "object":
            value = value if isinstance(value, dict) else {}
            return {k: fill(sub, value.get(k)) for k, sub in schema["properties"].items()}
        if t == "array":
            value = value if isinstance(value, list) else []
            return [fill(schema["items"], v) for v in value]
        if value is None:
            return ""
        return value if isinstance(value, str) else str(value)
    return fill(OUTPUT_SCHEMA, obj)


def generate(spec: dict, emit) -> None:
    text, finish = stream_completion(build_messages(spec),
                                     lambda t, c: emit({"type": "progress", "tokens": t, "chars": c}))
    if not text.strip():
        raise LlamaError("Model zwrócił pustą odpowiedź. Spróbuj ponownie.")
    obj, truncated = parse_character(text)
    if obj is None or not any(isinstance(v, (str, dict, list)) and v for v in obj.values()):
        # Not JSON – show as Markdown rather than failing silently.
        emit({"type": "done", "format": "markdown", "markdown": text,
              "warning": "Model nie zwrócił poprawnego JSON – pokazuję surowy tekst."})
        return
    warning = None
    if truncated or finish == "length":
        warning = "Odpowiedź modelu została ucięta (limit długości) – część sekcji może być niepełna."
    emit({"type": "done", "format": "json", "character": normalize_character(obj), "warning": warning})


# --------------------------------------------------------------------------- storage

def load_saved() -> list:
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def write_saved(items: list) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(DATA_FILE)


# --------------------------------------------------------------------------- rate limiting (public mode)

_rl_lock = threading.Lock()
_rl_hits: dict[str, deque] = {}
_daily = {"day": "", "count": 0}


def rate_limit(ip: str) -> str | None:
    """Returns an error message when the client is over the limit, otherwise records the hit."""
    now = time.time()
    with _rl_lock:
        today = time.strftime("%Y-%m-%d")
        if _daily["day"] != today:
            _daily.update(day=today, count=0)
            _rl_hits.clear()
        if _daily["count"] >= DAILY_LIMIT:
            return "Dzienny limit generowań na tej stronie został wyczerpany. Zapraszam jutro!"
        hits = _rl_hits.setdefault(ip, deque())
        while hits and now - hits[0] > _rl_window:
            hits.popleft()
        if len(hits) >= _rl_n:
            wait = int(_rl_window - (now - hits[0])) // 60 + 1
            return f"Limit: {_rl_n} postacie na {_rl_window // 60} min. Spróbuj ponownie za ok. {wait} min."
        hits.append(now)
        _daily["count"] += 1
    return None


# --------------------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "CharacterGenerator/1.0"

    def log_message(self, fmt, *args):
        if "/api/status" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self) -> str:
        # Behind Cloudflare Tunnel the real client is in CF-Connecting-IP.
        return (self.headers.get("CF-Connecting-IP")
                or (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
                or self.client_address[0])

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > (100_000 if PUBLIC else 5_000_000):
            raise ValueError("too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            return self._json(public_status() if PUBLIC else llama_status())
        if PUBLIC and path.startswith("/api/characters"):
            return self._json({"error": "Zapis na serwerze jest wyłączony – postacie zapisują się w przeglądarce."}, 404)
        if path == "/api/characters":
            with data_lock:
                items = load_saved()
            summary = [{k: it.get(k) for k in ("id", "timestamp", "name", "summary")} for it in items]
            return self._json(sorted(summary, key=lambda x: x.get("timestamp") or "", reverse=True))
        if path.startswith("/api/characters/"):
            cid = path.rsplit("/", 1)[1]
            with data_lock:
                it = next((x for x in load_saved() if x.get("id") == cid), None)
            return self._json(it) if it else self._json({"error": "Nie znaleziono postaci."}, 404)
        self._static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            body = self._body()
        except Exception:
            return self._json({"error": "Niepoprawne żądanie."}, 400)
        if path == "/api/generate":
            if PUBLIC and generation_lock.locked():
                return self._json({"error": "Trwa już inne generowanie – poczekaj na jego zakończenie."}, 409)
            if PUBLIC and not public_status()["ok"]:   # known offline - don't burn the visitor's limit
                return self._json({"error": MSG_PUBLIC_OFFLINE}, 503)
            if PUBLIC and (msg := rate_limit(self._client_ip())):
                return self._json({"error": msg}, 429)
            return self._generate(body)
        if PUBLIC:
            return self._json({"error": "Nie znaleziono."}, 404)
        if path == "/api/characters":
            item = {
                "id": uuid.uuid4().hex[:12],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "name": str(body.get("name") or "Bez imienia")[:200],
                "summary": str(body.get("summary") or "")[:300],
                "spec": body.get("spec"),
                "prompt": body.get("prompt") or "",
                "result": body.get("result"),
            }
            with data_lock:
                items = load_saved()
                items.append(item)
                write_saved(items)
            return self._json({"id": item["id"], "timestamp": item["timestamp"]})
        self._json({"error": "Nie znaleziono."}, 404)

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if not PUBLIC and path.startswith("/api/characters/"):
            cid = path.rsplit("/", 1)[1]
            with data_lock:
                items = load_saved()
                rest = [x for x in items if x.get("id") != cid]
                write_saved(rest)
            return self._json({"deleted": len(items) - len(rest)})
        self._json({"error": "Nie znaleziono."}, 404)

    def _generate(self, spec):
        if not isinstance(spec, dict):
            return self._json({"error": "Niepoprawna specyfikacja postaci."}, 400)
        if not generation_lock.acquire(blocking=False):
            return self._json({"error": "Trwa już inne generowanie – poczekaj na jego zakończenie."}, 409)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()

            def emit(obj):
                self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
                self.wfile.flush()

            try:
                generate(spec, emit)
            except LlamaError as e:
                emit({"type": "error", "message": str(e)})
            except (BrokenPipeError, ConnectionResetError):
                pass  # browser went away; closing upstream stops llama.cpp generation
            except Exception as e:  # never fail silently
                try:
                    emit({"type": "error", "message": f"Nieoczekiwany błąd serwera: {e}"})
                except Exception:
                    pass
        finally:
            generation_lock.release()
        self.close_connection = True

    def _static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC / path.lstrip("/")).resolve()
        if STATIC not in target.parents or not target.is_file():
            return self._json({"error": "Nie znaleziono."}, 404)
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    mimetypes.add_type("application/javascript", ".js")
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    mode = f"PUBLICZNY, limit {_rl_n}/{_rl_window}s, {DAILY_LIMIT}/dzień" if PUBLIC else "lokalny"
    print(f"Generator postaci: http://{HOST}:{PORT}   (LLM: {LLAMA_URL}, klucz API: {'tak' if LLAMA_API_KEY else 'nie'}, tryb: {mode})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
