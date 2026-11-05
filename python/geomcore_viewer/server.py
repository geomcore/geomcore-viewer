"""Local server: serves the built frontend, the scene API and SSE fan-out.

Stdlib only. Static hosting (GitHub Pages) skips this entirely and loads
a scene document instead — see protocol/SCENE.md (v2).
"""

from __future__ import annotations

import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

APP = "geomcore-viewer"
PROTOCOL = 2
DEFAULT_PORT = 8765
URL_ENV = "GEOMCORE_VIEWER_URL"  # overrides the default server URL (and the CLI's default port)
_KEEPALIVE_S = 15.0


def default_url() -> str:
    """``$GEOMCORE_VIEWER_URL`` when set and not blank, else the local default."""
    return (os.environ.get(URL_ENV, "").strip() or f"http://127.0.0.1:{DEFAULT_PORT}").rstrip("/")


def default_port() -> int:
    """The port of :func:`default_url`: 80 when the URL names none, as ``http://`` means.

    Raises ValueError, naming the variable, when the port is malformed.
    """
    url = default_url()
    try:
        port = urlparse(url).port
    except ValueError as err:
        raise ValueError(f"{URL_ENV}={url!r} has a malformed port ({err})") from None
    return 80 if port is None else port


def allowed_hosts(port: int) -> set[str]:
    """``Host`` values that name this server; browsers leave out the default port 80."""
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if port == 80:
        hosts |= {"127.0.0.1", "localhost"}
    return hosts


_MIME = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".wasm": "application/wasm",
}

_PLACEHOLDER = (
    b"<!doctype html><meta charset='utf-8'><title>geomcore-viewer</title>"
    b"<p>Frontend not built. Run <code>scripts/bundle-frontend.sh</code> "
    b"(or <code>npm run build</code> in <code>frontend/</code>).</p>"
)


def default_frontend_dir() -> Path:
    """The build bundled in the wheel, else a source checkout's ``frontend/dist``."""
    bundled = Path(__file__).parent / "_frontend"
    if (bundled / "index.html").is_file():
        return bundled
    return Path(__file__).resolve().parents[2] / "frontend" / "dist"


def _valid_object(obj: object) -> bool:
    if not isinstance(obj, dict) or not isinstance(obj.get("id"), str):
        return False
    geom = obj.get("geom")
    return isinstance(geom, dict) and isinstance(geom.get("type"), str)


class _State:
    def __init__(self) -> None:
        self.title = ""
        self.view = "auto"
        self.run: str | None = None
        self.steps: list[str] = []
        self.objects: dict[str, dict] = {}
        self.subscribers: list[queue.Queue[str]] = []
        self.lock = threading.Lock()

    def _doc(self) -> dict:
        return {
            "version": PROTOCOL,
            "title": self.title,
            "run": self.run,
            "view": self.view,
            "steps": list(self.steps),
            "objects": list(self.objects.values()),
        }

    def snapshot(self) -> dict:
        with self.lock:
            return self._doc()

    def _broadcast(self, event: dict) -> None:
        payload = f"data: {json.dumps(event)}\n\n"
        for sub in self.subscribers:
            sub.put(payload)

    def post(self, batch: dict) -> None:
        with self.lock:
            run = batch.get("run")
            if isinstance(run, str) and run != self.run:
                keep = bool(batch.get("keep"))
                self.run = run
                if not keep:
                    self.objects.clear()
                    self.steps.clear()
                    self.title, self.view = "", "auto"
                self._broadcast({"type": "run", "run": run, "keep": keep})
            if isinstance(batch.get("title"), str):
                self.title = batch["title"]
            if isinstance(batch.get("view"), str):
                self.view = batch["view"]
            steps = batch.get("steps")
            if isinstance(steps, list) and all(isinstance(f, str) for f in steps):
                self.steps = list(steps)
            objects = batch.get("objects", [])
            for obj in objects:
                self.objects[obj["id"]] = obj
            self._broadcast({"type": "upsert", "objects": objects, "title": self.title,
                             "view": self.view, "steps": list(self.steps)})

    def remove(self, object_id: str) -> bool:
        with self.lock:
            if self.objects.pop(object_id, None) is None:
                return False
            self._broadcast({"type": "remove", "id": object_id})
            return True

    def clear(self) -> None:
        with self.lock:
            self.objects.clear()
            self.steps.clear()
            self._broadcast({"type": "clear"})

    def subscribe(self) -> queue.Queue[str]:
        """A new event queue that starts with the full scene.

        The scene is enqueued under the lock that registers the subscriber, so no
        event can fall between the snapshot and the events that follow it.
        """
        sub: queue.Queue[str] = queue.Queue()
        with self.lock:
            sub.put(f"data: {json.dumps({'type': 'scene', 'doc': self._doc()})}\n\n")
            self.subscribers.append(sub)
        return sub

    def unsubscribe(self, sub: queue.Queue[str]) -> None:
        with self.lock:
            self.subscribers.remove(sub)


def make_handler(frontend_dir: Path, state: _State) -> type[BaseHTTPRequestHandler]:
    root = frontend_dir.resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = f"{APP}/{PROTOCOL}"

        def log_message(self, *args: object) -> None:
            pass

        def _send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, obj: object, status: int = 200) -> None:
            self._send_bytes(json.dumps(obj).encode(), "application/json", status)

        def _local_request(self) -> bool:
            """Only this server's own page (or a same-host script) may talk to it.

            Any website can make the browser send requests to 127.0.0.1, so the
            ``Host`` (DNS rebinding) and ``Origin`` (cross-site fetch) headers
            must name this server. Answers 403 itself when they do not.
            """
            hosts = allowed_hosts(self.server.server_address[1])
            origin = self.headers.get("Origin")
            if self.headers.get("Host") in hosts and (origin is None or origin in {f"http://{h}" for h in hosts}):
                return True
            # "app" lets a client tell this refusal (e.g. through a port-changing tunnel) from another program.
            self._send_json({"error": "request is not from this server's own origin", "app": APP}, 403)
            return False

        def _read_json(self) -> object:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length) if length else b"{}")

        def do_GET(self) -> None:
            if not self._local_request():
                return
            path = urlparse(self.path).path
            if path == "/api/health":
                self._send_json({"app": APP, "protocol": PROTOCOL})
            elif path == "/api/scene":
                self._send_json(state.snapshot())
            elif path == "/events":
                self._stream_events()
            else:
                self._send_static(path)

        def _stream_events(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            sub = state.subscribe()
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    try:
                        payload = sub.get(timeout=_KEEPALIVE_S)
                    except queue.Empty:
                        payload = ": ping\n\n"
                    self.wfile.write(payload.encode())
                    self.wfile.flush()
            except (ConnectionError, BrokenPipeError):
                pass  # browser tab closed or reloaded
            finally:
                state.unsubscribe(sub)

        def _send_static(self, path: str) -> None:
            rel = path.lstrip("/") or "index.html"
            target = (root / rel).resolve()
            if target.is_dir():
                target = target / "index.html"
            if not target.is_relative_to(root) or not target.is_file():
                if rel == "index.html":
                    self._send_bytes(_PLACEHOLDER, "text/html")
                else:
                    self.send_error(404)
                return
            self._send_bytes(target.read_bytes(), _MIME.get(target.suffix, "application/octet-stream"))

        def do_POST(self) -> None:
            if not self._local_request():
                return
            # A cross-site page can only send simple content types without a
            # preflight (which this server never answers): insist on JSON.
            if self.headers.get_content_type() != "application/json":
                self._send_json({"error": "Content-Type must be application/json"}, 415)
                return
            path = urlparse(self.path).path
            try:
                body = self._read_json()
            except ValueError:
                self._send_json({"error": "body is not JSON"}, 400)
                return
            if path == "/api/objects":
                objects = body.get("objects") if isinstance(body, dict) else None
                if not isinstance(objects, list) or not all(_valid_object(o) for o in objects):
                    self._send_json({"error": 'expected {"objects": [...]}, each with a string id and geom.type'}, 400)
                    return
                state.post(body)
            elif path == "/api/clear":
                state.clear()
            elif path == "/api/shutdown":
                self._send_json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            else:
                self.send_error(404)
                return
            self._send_json({"ok": True})

        def do_DELETE(self) -> None:
            if not self._local_request():
                return
            path = urlparse(self.path).path
            prefix = "/api/objects/"
            if not path.startswith(prefix):
                self.send_error(404)
                return
            if state.remove(unquote(path[len(prefix):])):
                self._send_json({"ok": True})
            else:
                self._send_json({"error": "no such object"}, 404)

    return Handler


class Server:
    """Local viewer server. Background thread via :meth:`start`, or a context manager."""

    def __init__(self, frontend_dir: str | Path | None = None, port: int = DEFAULT_PORT) -> None:
        self.state = _State()
        directory = Path(frontend_dir) if frontend_dir is not None else default_frontend_dir()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(directory, self.state))
        self.port = self.httpd.server_address[1]
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> Server:
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._thread.is_alive():
            self.httpd.shutdown()
            self._thread.join(timeout=5)
        self.httpd.server_close()

    def __enter__(self) -> Server:
        return self.start()

    def __exit__(self, *args: object) -> None:
        self.stop()
