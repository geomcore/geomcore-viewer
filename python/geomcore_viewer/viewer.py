"""Client: add geometry to the live viewer page, or save it as a scene file."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
import warnings
import webbrowser
from pathlib import Path
from urllib.parse import quote

from .adapt import PALETTE, SURFACE_TYPES, as_vec, indexed, scene_extent, to_objects, uv_curve, with_window
from .server import PROTOCOL, default_url
from .spawn import ensure_server, probe, refused_hint

# Categorical palette: every colour has contrast ≥ 3:1 on the viewer's light (#f7f8fa) and
# dark (#16181d) backgrounds (spec §3.5, tests/test_viewer.py), so it reads on a projector.
STYLE_KEYS = ("color", "width", "dashed", "opacity")
EXTRA_KEYS = frozenset({"foci", "center", "axes", "asymptotes", "directrix", "vertex", "isolines", "wire"})
VIEWS = ("auto", "2d", "3d")

_default: Viewer | None = None


def _check_serializable(obj: dict) -> None:
    """Reject an object the server could not receive, before any state is changed."""
    try:
        json.dumps(obj, allow_nan=False)
    except ValueError:
        raise ValueError(f"{obj['id']}: geometry, style or extras have NaN or infinite values") from None
    except TypeError as err:
        raise TypeError(f"{obj['id']}: {err}") from None


class Handle:
    """One object in the scene, as returned by :meth:`Viewer.add`."""

    def __init__(self, viewer: Viewer, object_id: str) -> None:
        self.viewer = viewer
        self.id = object_id

    def update(self, **style) -> None:
        """Change ``color``, ``width``, ``dashed`` or ``opacity`` in place."""
        self.viewer._restyle(self.id, style)

    def remove(self) -> None:
        self.viewer._remove(self.id)
        self.viewer._flush()

    def __repr__(self) -> str:
        return f"Handle({self.id!r})"


class Viewer:
    """A live scene in the browser viewer.

    Every :meth:`add` appears immediately in the open tab. A new ``Viewer``
    (re-running a script) starts a new *run*: the tab swaps to it on its
    first object unless ``keep=True``. The most recently created viewer is
    the default target of the module-level :func:`add`, so ``gv.add(x)`` at
    a ``pdb`` prompt lands in the script's scene.
    """

    def __init__(
        self,
        title: str = "",
        *,
        view: str = "auto",
        keep: bool = False,
        url: str | None = None,
        open_browser: bool = True,
        spawn: bool = True,
    ) -> None:
        global _default
        if view not in VIEWS:
            raise ValueError(f"view must be one of {VIEWS}, got {view!r}")
        self.title, self.view, self.keep = title, view, keep
        self.url = (url or default_url()).rstrip("/")
        self.open_browser, self.spawn = open_browser, spawn
        self.run = uuid.uuid4().hex[:12]
        self.objects: dict[str, dict] = {}
        self._families: dict[str, list[str]] = {}  # label → ids its last add produced
        self._unsent: list[str] = []
        self._pending_removals: list[str] = []  # deletes the server has not acknowledged yet
        self._pending_clear = False
        self._run_sent = False  # this run has reached a server at least once
        self._resync = False  # the server may have lost our scene: re-send everything
        self._online: bool | None = None  # None until the first send
        self._warned = False
        self._next_color = 0
        self._next_auto = 0
        _default = self

    # -- adding ------------------------------------------------------------
    def add(self, *objs, label: str | None = None, group: str | None = None, u=None, v=None, **options):
        """Show geomcore objects, intersection results, points, or lists of them.

        Style: ``color``, ``width``, ``dashed``, ``opacity``. Curve extras:
        ``foci``, ``center``, ``axes``, ``asymptotes``, ``directrix``,
        ``vertex``; surface extras ``isolines``, ``wire``; ``u=``/``v=``
        set a surface's parameter window. Re-adding a ``label`` replaces
        what that label showed before.
        """
        if not objs:
            raise TypeError("add() needs at least one object")
        parts: list[dict] = []
        for i, obj in enumerate(objs, start=1):
            part_label = label if len(objs) == 1 or label is None else indexed(label, i)
            parts += to_objects(obj, part_label, u=u, v=v)
        return self._commit(parts, label, group, options, u, v)

    def pcurve(self, curve, on, *, label: str | None = None, group: str | None = None, **options):
        """Show a curve given in a surface's (u, v) parameters: a geomcore ``Line2D`` or
        ``Circle2D`` (e.g. ``circle.parametrize_on(surface)``) or a sequence of ``(u, v)``
        pairs. ``on`` is the surface, already added: its :class:`Handle` or id. The page
        draws the curve on the surface in 3D and in the (u,v) pane.
        """
        surface = on.id if isinstance(on, Handle) else on
        if self.objects.get(surface, {}).get("geom", {}).get("type") not in SURFACE_TYPES:
            raise ValueError(f"pcurve: {surface!r} is not a surface in this scene (add the surface first)")
        geom = {"type": "pcurve", "surface": surface, "curve": uv_curve(curve)}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def polyline(self, points, *, label: str | None = None, group: str | None = None, **options):
        geom = {"type": "polyline", "points": [as_vec(p) for p in points]}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def mesh(self, vertices, indices, *, label: str | None = None, group: str | None = None, **options):
        geom = {"type": "mesh", "vertices": [as_vec(p) for p in vertices], "indices": [int(i) for i in indices]}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def arrow(self, at, vec, *, label: str | None = None, group: str | None = None, **options):
        geom = {"type": "arrow", "at": as_vec(at), "vec": as_vec(vec)}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def text(self, at, text, *, label: str | None = None, group: str | None = None, **options):
        geom = {"type": "text", "at": as_vec(at), "text": str(text)}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def _commit(self, parts: list[dict], label, group, options: dict, u=None, v=None):
        style = {k: options.pop(k) for k in STYLE_KEYS if k in options and options[k] is not None}
        for k in STYLE_KEYS:
            options.pop(k, None)
        unknown = set(options) - EXTRA_KEYS
        if unknown:
            raise TypeError(f"unexpected keyword argument(s): {', '.join(sorted(unknown))}")
        objects = [self._build(part, style, group, options, u, v) for part in parts]
        for obj in objects:
            self.objects[obj["id"]] = obj
            self._unsent.append(obj["id"])
        ids = list(dict.fromkeys(obj["id"] for obj in objects))
        if label is not None:
            for stale in self._families.get(label, []):
                if stale not in ids:
                    self._remove(stale)
            self._families[label] = ids
        self._flush()
        handles = [Handle(self, i) for i in ids]
        return handles[0] if len(handles) == 1 else handles

    def _build(self, part: dict, style: dict, group, extras: dict, u, v) -> dict:
        geom = part["geom"]
        object_id = part.get("key") or part["label"] or self._auto_id()
        if geom["type"] in SURFACE_TYPES and "window" not in geom:
            others = (o["geom"] for o in self.objects.values() if o["id"] != object_id)
            geom = with_window(geom, scene_extent(others), u, v)
        obj: dict = {"id": object_id, "geom": geom}
        if part["label"]:
            obj["label"] = part["label"]
        if part.get("source"):
            obj["source"] = part["source"]
        group = group or part.get("group")
        if group:
            obj["group"] = group
        if geom["type"] != "note":
            previous = self.objects.get(object_id, {}).get("style", {})
            part_style = part.get("style", {})
            color = previous.get("color") or part_style.get("color") or self._color()
            applied = {k: x for k, x in style.items() if k not in part.get("keeps_style", ())}
            obj["style"] = {**part_style, "color": color, **applied}
        if extras:
            obj["extras"] = dict(extras)
        if part.get("meta"):
            obj["meta"] = part["meta"]
        _check_serializable(obj)
        return obj

    def _color(self) -> str:
        color = PALETTE[self._next_color % len(PALETTE)]
        self._next_color += 1
        return color

    def _auto_id(self) -> str:
        self._next_auto += 1
        return f"{self.run[:6]}-{self._next_auto}"

    # -- changing and removing -------------------------------------------------
    def _restyle(self, object_id: str, style: dict) -> None:
        unknown = set(style) - set(STYLE_KEYS)
        if unknown:
            raise TypeError(f"unexpected style keyword(s): {', '.join(sorted(unknown))}")
        if object_id not in self.objects:
            raise KeyError(f"{object_id!r} is no longer in the scene")
        current = self.objects[object_id]
        updated = {**current, "style": {**current.get("style", {}), **style}}
        _check_serializable(updated)
        self.objects[object_id] = updated
        self._unsent.append(object_id)
        self._flush()

    def _remove(self, object_id: str) -> None:
        """Drop an object here and queue its deletion on the server (sent by ``_flush``)."""
        self.objects.pop(object_id, None)
        self._unsent = [i for i in self._unsent if i != object_id]
        if self._run_sent:
            self._pending_removals.append(object_id)

    def clear(self) -> None:
        """Empty the scene, here and in the open tab."""
        self.objects.clear()
        self._families.clear()
        self._unsent.clear()
        self._pending_removals.clear()
        self._pending_clear = True
        self._flush()

    # -- persistence -----------------------------------------------------------
    def scene(self) -> dict:
        return {"version": PROTOCOL, "title": self.title, "run": self.run, "view": self.view,
                "objects": list(self.objects.values())}

    def save(self, path: str | Path) -> Path:
        """Write the scene as JSON (open it with ``?scene=`` or drag-drop it on the page)."""
        out = Path(path)
        out.write_text(json.dumps(self.scene(), allow_nan=False))
        return out

    def open(self) -> None:
        """Open the viewer page in the browser (e.g. after closing the tab)."""
        webbrowser.open(self.url)

    # -- transport -------------------------------------------------------------
    def _flush(self) -> None:
        """Bring the server up to date: pending clear, then deletes, then upserts."""
        if not (self._unsent or self._pending_removals or self._pending_clear) or not self._connect():
            return
        if self._pending_clear:
            self._pending_clear = False
            if not self._request("POST", "/api/clear", {}):
                self._pending_clear = True
                return
        while self._pending_removals:
            object_id = self._pending_removals.pop(0)
            if not self._request("DELETE", f"/api/objects/{quote(object_id, safe='')}", missing_ok=True):
                self._pending_removals.insert(0, object_id)
                return
        if not self._unsent:
            return
        ids = list(dict.fromkeys(self._unsent))
        batch: dict = {"objects": [self.objects[i] for i in ids if i in self.objects],
                       "title": self.title, "view": self.view}
        if self._resync or not self._run_sent:
            batch.update(run=self.run, keep=self.keep)
        try:
            sent = self._request("POST", "/api/objects", batch)
        except RuntimeError:
            # A rejected batch must not block every later add.
            self._unsent = [i for i in self._unsent if i not in ids]
            raise
        if sent:
            self._run_sent, self._resync = True, False
            self._unsent.clear()

    def _connect(self) -> bool:
        if self._online:
            return True
        if self.spawn:
            return self._spawn_or_find()
        state = probe(self.url)
        self._online = state == "ours"
        if state == "refused":
            self._warn(f"{refused_hint(self.url)}; keeping objects locally (save() still works)")
        elif not self._online:
            self._warn(f"no geomcore-viewer at {self.url}; keeping objects locally (save() still works)")
        else:
            self._reconnected()
        return self._online

    def _spawn_or_find(self) -> bool:
        """Find the server, starting it when it is not running (also after it died mid-session)."""
        first = self._online is None
        try:
            started = ensure_server(self.url)
        except RuntimeError as err:
            if first:
                raise
            self._warn(f"geomcore-viewer at {self.url} is still unreachable ({err}); keeping objects locally")
            return False
        if started:
            print(f"geomcore-viewer: {self.url}")
            if self.open_browser and first:  # a tab that is already open reconnects by itself
                webbrowser.open(self.url)
        self._online = True
        self._reconnected()
        return True

    def _reconnected(self) -> None:
        self._warned = False  # a later outage deserves its own warning

    def _request(self, method: str, path: str, body: dict | None = None, missing_ok: bool = False) -> bool:
        data = None if body is None else json.dumps(body, allow_nan=False).encode()
        req = urllib.request.Request(f"{self.url}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5):
                return True
        except urllib.error.HTTPError as err:
            if missing_ok and err.code == 404:
                return True
            raise RuntimeError(f"geomcore-viewer rejected {method} {path}: {err.read().decode(errors='replace')}") from err
        except OSError as err:
            # The server may come back empty, so the whole scene goes out again.
            self._online = False
            self._resync = self._run_sent
            self._unsent = list(self.objects)
            self._warn(f"geomcore-viewer at {self.url} is unreachable ({err}); keeping objects locally")
            return False

    def _warn(self, message: str) -> None:
        if not self._warned:
            self._warned = True
            warnings.warn(message, RuntimeWarning, stacklevel=4)


def viewer() -> Viewer:
    """The default viewer: the most recently created one, else a new one."""
    return _default if _default is not None else Viewer()


def add(*objs, **kwargs):
    """``viewer().add(...)`` — one line at a ``pdb`` prompt, a REPL or a notebook cell."""
    return viewer().add(*objs, **kwargs)


def clear() -> None:
    viewer().clear()
