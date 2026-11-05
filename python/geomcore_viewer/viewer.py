"""Client: add geometry to the live viewer page, or save it as a scene file."""

from __future__ import annotations

import json
import math
import numbers
import urllib.error
import urllib.request
import uuid
import warnings
import webbrowser
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

from .adapt import PALETTE, SURFACE_TYPES, as_vec, extra_data, indexed, missing_window, scene_extent, to_objects, uv_curve, with_window
from .server import PROTOCOL, default_url
from .spawn import ensure_server, probe, refused_hint

# Categorical palette: every colour has contrast ≥ 3:1 on the viewer's light (#f7f8fa) and
# dark (#16181d) backgrounds (spec §3.5, tests/test_viewer.py), so it reads on a projector.
STYLE_KEYS = ("color", "width", "dashed", "opacity")
EXTRA_KEYS = frozenset({
    "foci", "center", "axes", "asymptotes", "directrix", "vertex", "isolines", "wire",
    "poles", "knots", "comb", "normals",
})
VIEWS = ("auto", "2d", "3d")
DEFAULT_COLORMAP = "viridis"
# The colour maps the page knows (frontend/src/ui/colormap.ts).
COLORMAPS = ("viridis", "plasma", "turbo", "coolwarm", "gray")

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
        self.steps: list[str] = []  # step names in the order they were opened
        self._step: str | None = None  # the step being filled, inside `with view.step(...)`
        self._steps_unsent = False  # the step list changed since the server last heard it
        self._families: dict[tuple, list[str]] = {}  # (step, label) → ids its last add produced
        self._unsent: list[str] = []
        self._pending_removals: list[str] = []  # deletes the server has not acknowledged yet
        self._pending_clear = False
        self._run_sent = False  # this run has reached a server at least once
        self._resync = False  # the server may have lost our scene: re-send everything
        self._online: bool | None = None  # None until the first send
        self._warned = False
        self._batch_depth = 0  # > 0 inside `with view.batch()`: sends wait for the exit
        self._next_color = 0
        self._next_auto = 0
        _default = self

    # -- adding ------------------------------------------------------------
    def add(self, *objs, label: str | None = None, group: str | None = None, u=None, v=None, operands=True,
            **options):
        """Show geomcore objects, intersection results, points, or lists of them.

        Style: ``color``, ``width``, ``dashed``, ``opacity``. Curve extras:
        ``foci``, ``center``, ``axes``, ``asymptotes``, ``directrix``,
        ``vertex``; B-spline and Bézier extras: ``poles`` (control polygon),
        ``knots`` (knot points), ``comb=scale`` (curvature comb); surface extras
        ``isolines``, ``wire``, ``normals=n``; ``u=``/``v=`` set a surface's
        parameter window. A result draws its operands faded, except any the
        scene already shows (equal value, windows aside): those it reuses, so
        removing that object later removes it from the result's display too,
        and an operand added after the result is drawn again. Pass
        ``operands=False`` to leave all of them out. Re-adding a ``label``
        replaces what that label showed before.
        """
        if not objs:
            raise TypeError("add() needs at least one object")
        parts: list[dict] = []
        for i, obj in enumerate(objs, start=1):
            part_label = label if len(objs) == 1 or label is None else indexed(label, i)
            # What the scene already shows here: objects outside any step and in this step, less the
            # family this label is replacing.
            replaced = set(self._families.get((self._step, label), ())) if label is not None else set()
            existing = [o["geom"] for o in self.objects.values()
                        if o["id"] not in replaced and o.get("step") in (None, self._step)] + [p["geom"] for p in parts]
            object_parts = to_objects(obj, part_label, u=u, v=v, existing=existing, operands=operands)
            if len(object_parts) == 1:
                # Poles, knots, combs and normals come from the exact object, once its window is known.
                object_parts[0]["exact_object"] = obj
            parts += object_parts
        return self._commit(parts, label, group, options, u, v)

    def pcurve(self, curve, on, *, label: str | None = None, group: str | None = None, **options):
        """Show a curve given in a surface's (u, v) parameters: any geomcore 2D curve — a
        ``Line2D``/``Circle2D`` or one of the others, sampled to a polyline — or a sequence of
        ``(u, v)`` pairs. ``on`` is the surface, already added: its :class:`Handle` or id. The
        page draws the curve on the surface in 3D and in the (u,v) pane.
        """
        surface = on.id if isinstance(on, Handle) else on
        if self._step is not None and f"{self._step}·{surface}" in self.objects:
            surface = f"{self._step}·{surface}"  # a label given inside a step names that step's object
        if self.objects.get(surface, {}).get("geom", {}).get("type") not in SURFACE_TYPES:
            raise ValueError(f"pcurve: {surface!r} is not a surface in this scene (add the surface first)")
        geom = {"type": "pcurve", "surface": surface, "curve": uv_curve(curve)}
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def polyline(self, points, *, label: str | None = None, group: str | None = None, **options):
        """One polyline, or several when ``points`` is a list of point lists."""
        geoms = [{"type": "polyline", "points": [as_vec(p) for p in one]} for one in _polylines(points)]
        return self._commit(_labelled_geoms(geoms, label), label, group, options)

    def mesh(self, vertices, indices, *, values=None, colormap: str | None = None,
             label: str | None = None, group: str | None = None, **options):
        """One mesh; ``values=`` (one per vertex, with a ``colormap``) colours it by scalar."""
        geom = {"type": "mesh", "vertices": [as_vec(p) for p in vertices], "indices": [int(i) for i in indices]}
        if values is not None:
            geom["values"] = _scalars(values, len(geom["vertices"]), "vertex")
            geom["colormap"] = _colormap(colormap, "mesh")
        elif colormap is not None:
            raise ValueError("mesh: colormap= needs values=")
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def points(self, xyz, *, values=None, colormap: str | None = None, size: float | None = None,
               label: str | None = None, group: str | None = None, **options):
        """A point cloud as one object (one panel row, one request). ``values=`` (one per point)
        colours each point through ``colormap`` (default "viridis"; also "plasma", "turbo",
        "coolwarm", "gray"); ``size=`` is its dot radius in pixels."""
        positions = [as_vec(p) for p in xyz]
        if not positions:
            raise ValueError("points: xyz is empty")
        geom = {"type": "points", "positions": positions}
        if size is not None:
            geom["size"] = float(size)
        if values is not None:
            geom["values"] = _scalars(values, len(positions), "point")
            geom["colormap"] = _colormap(colormap, "points")
        elif colormap is not None:
            raise ValueError("points: colormap= needs values=")
        return self._commit([{"label": label, "geom": geom}], label, group, options)

    def arrow(self, at, vec, *, label: str | None = None, group: str | None = None, **options):
        """One arrow, or a list: ``at`` and ``vec`` may each be a list of points, zipped."""
        ats = list(at) if _points_listed(at) else [at]
        vecs = list(vec) if _points_listed(vec) else [vec]
        geoms = [{"type": "arrow", "at": as_vec(p), "vec": as_vec(v)} for p, v in _paired(ats, vecs)]
        return self._commit(_labelled_geoms(geoms, label), label, group, options)

    def text(self, at, text, *, label: str | None = None, group: str | None = None, **options):
        """One text, or a list: ``at`` may be a list of points and ``text`` a string (repeated)
        or a list of strings, zipped."""
        ats = list(at) if _points_listed(at) else [at]
        texts = list(text) if _is_sequence(text) else [text]
        geoms = [{"type": "text", "at": as_vec(p), "text": str(t)} for p, t in _paired(ats, texts)]
        return self._commit(_labelled_geoms(geoms, label), label, group, options)

    @contextmanager
    def step(self, name: str):
        """A lesson step: objects added inside belong to ``name``. The page shows one step at a
        time (a slider and ←/→), so a parameter can be re-drawn per value instead of piling the
        states on top of each other. Objects added outside any step stay in every step. Re-entering
        a step's name adds to that step; steps do not nest."""
        if self._step is not None:
            raise ValueError(f"step({name!r}) inside step({self._step!r}): steps do not nest")
        name = str(name)
        if name not in self.steps:
            self.steps.append(name)
            self._steps_unsent = True
        self._step = name
        try:
            yield self
        finally:
            self._step = None
            self._flush()  # the step list may be new, even when nothing else changed

    @contextmanager
    def batch(self):
        """Send everything added inside the block in one request, instead of one per call:
        ``with view.batch(): view.arrow(...) ...``. Batches nest (the outermost one sends). If the
        block raises, what it added before the error is still sent, then the error propagates."""
        self._batch_depth += 1
        try:
            yield self
        finally:
            self._batch_depth -= 1
            if self._batch_depth == 0:
                self._flush()

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
            family = (self._step, label)
            for stale in self._families.get(family, []):
                if stale not in ids:
                    self._remove(stale)
            self._families[family] = ids
        self._flush()
        handles = [Handle(self, i) for i in ids]
        return handles[0] if len(handles) == 1 else handles

    def _build(self, part: dict, style: dict, group, extras: dict, u, v) -> dict:
        geom = part["geom"]
        object_id = part.get("key") or part["label"] or self._auto_id()
        if self._step is not None:
            object_id = f"{self._step}·{object_id}"  # labels may repeat across steps; ids must not
        # u= / v= narrow a surface even when its adapter already windowed it (a revolution's
        # bounded profile, say).
        if geom["type"] in SURFACE_TYPES and (missing_window(geom) or u is not None or v is not None):
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
        computed = {}
        if part.get("exact_object") is not None:
            window = geom.get("window") or {}
            computed = extra_data(part["exact_object"], extras, window.get("u", u), window.get("v", v))
        if extras or computed:
            obj["extras"] = {**extras, **computed}
        if part.get("meta"):
            obj["meta"] = part["meta"]
        if self._step is not None:
            obj["step"] = self._step
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
        # Inside a step, what follows still belongs to that step.
        self.steps[:] = [self._step] if self._step is not None else []
        self._steps_unsent = self._step is not None
        self._families.clear()
        self._unsent.clear()
        self._pending_removals.clear()
        self._pending_clear = True
        self._flush()

    # -- persistence -----------------------------------------------------------
    def scene(self) -> dict:
        return {"version": PROTOCOL, "title": self.title, "run": self.run, "view": self.view,
                "steps": list(self.steps), "objects": list(self.objects.values())}

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
        """Bring the server up to date: pending clear, then deletes, then upserts. Inside a
        ``batch()`` block nothing is sent until the outermost block exits."""
        if self._batch_depth:
            return
        if not (self._unsent or self._steps_unsent or self._pending_removals or self._pending_clear) \
                or not self._connect():
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
        if not (self._unsent or self._steps_unsent):
            return
        ids = list(dict.fromkeys(self._unsent))
        batch: dict = {"objects": [self.objects[i] for i in ids if i in self.objects],
                       "title": self.title, "view": self.view, "steps": list(self.steps)}
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
            self._steps_unsent = False

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


def _is_sequence(value) -> bool:
    """A list, a tuple, a numpy array or any other sized iterable that is not a string."""
    return not isinstance(value, (str, bytes)) and hasattr(value, "__len__") and hasattr(value, "__iter__")


def _is_point(value) -> bool:
    """A point or vector: a geomcore point/vector, or a sequence of 2 or 3 numbers (numpy rows
    and numpy scalars included, without importing numpy)."""
    if hasattr(value, "x") and not callable(value.x):
        return True
    if hasattr(value, "components"):
        return True
    return _is_sequence(value) and len(value) in (2, 3) and all(isinstance(c, numbers.Real) for c in value)


def _points_listed(value) -> bool:
    """True for a list of points (`[(0, 0), (1, 1)]`, an (N, 3) array) as opposed to one point."""
    return _is_sequence(value) and len(value) > 0 and all(_is_point(v) for v in value)


def _polylines(points) -> list:
    """One polyline's point list, or a list of them when ``points`` is a list of point lists."""
    items = list(points)
    return [list(one) for one in items] if items and not all(_is_point(p) for p in items) else [items]


def _paired(left, right):
    """Zip two lists, repeating a single item; a length mismatch is a clear TypeError."""
    a, b = list(left), list(right)
    if len(a) == 1:
        a *= len(b)
    if len(b) == 1:
        b *= len(a)
    if len(a) != len(b):
        raise TypeError(f"expected the same number of items, got {len(a)} and {len(b)}")
    return zip(a, b)


def _colormap(name: str | None, method: str) -> str:
    """The colour map to send: ``name``, or the default; an unknown name is a ValueError here
    rather than a silent fallback in the page."""
    if name is None:
        return DEFAULT_COLORMAP
    if name not in COLORMAPS:
        raise ValueError(f"{method}: unknown colormap {name!r}; expected one of {', '.join(COLORMAPS)}")
    return name


def _scalars(values, count: int, unit: str) -> list[float]:
    """A scalar field as JSON numbers: one finite number per point or vertex."""
    out = [float(v) for v in values]
    if len(out) != count:
        raise ValueError(f"values needs one number per {unit} ({count}), got {len(out)}")
    if any(not math.isfinite(v) for v in out):
        raise ValueError("values must be finite")
    return out


def _labelled_geoms(geoms: list[dict], label: str | None) -> list[dict]:
    """Parts for raw geoms: `label`, or `label₁`, `label₂` … when there are several."""
    return [{"label": label if len(geoms) == 1 or label is None else indexed(label, i), "geom": geom}
            for i, geom in enumerate(geoms, start=1)]


def add(*objs, **kwargs):
    """``viewer().add(...)`` — one line at a ``pdb`` prompt, a REPL or a notebook cell."""
    return viewer().add(*objs, **kwargs)


def clear() -> None:
    viewer().clear()
