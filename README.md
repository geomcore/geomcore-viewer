# geomcore-viewer

A live, geometry-aware browser viewer for [geomcore](https://github.com/geomcore/geomcore).
Write geomcore code, call `view.add(...)`, and the curves, surfaces and
intersection points appear — exactly, not as hand-sampled polylines — in a
browser tab that updates as your script, debugger or notebook runs.

```python
# conics.py — run with: python conics.py   (re-run after every edit)
from geomcore import Frame3D, Point3D, Vector3D
from geomcore.curves import Circle3D, Ellipse3D
import geomcore_viewer as gv

view = gv.Viewer("Ellipse ∩ circle")
E = Ellipse3D.from_frame(Frame3D.world(), 3.0, 2.0)
C = Circle3D(Point3D(2, 1, 0), Vector3D.unit_z(), 1.5)

view.add(E, label="E")
view.add(C, label="C")
view.add(C.intersect(E), label="P")   # → P₁, P₂
```

- **One verb.** `add` takes geomcore curves, surfaces and points, the result
  objects of projections, intersections and curve extrema (see
  [Drawing results](#drawing-results)), and lists of those. With geomcore ≤ 0.35
  it also takes the older `(tag, payload)` intersection results as returned
  (`("points", …)`, `("empty", None)` → a note "P: ∅").
- **Live, incremental.** The first `add` starts a background server and opens
  the tab; later runs reuse it. Re-running a script swaps the scene in place;
  inside one process (`pdb`, IPython, Jupyter) every `gv.add(x)` lands in the
  same scene. Re-adding a label updates that object instead of duplicating it.
- **Exact.** Objects travel as analytic definitions (frame + radii); the
  viewer evaluates them with geomcore's own parametrizations. The plane view
  clips lines, parabolas and hyperbolas to the window in closed form, so they
  run edge to edge at any zoom; the 3D view draws them across 1.5× the
  scene's extent.
- **Static too.** `view.save("scene.json")`, then open the hosted viewer with
  `?scene=<url>` or drag-drop the file onto it.

## Install

```sh
pip install geomcore-viewer        # stdlib only; the built viewer ships in the wheel
```

The viewer itself has no dependencies, but the quick-start above and the scripts in
`examples/` build their objects with geomcore 0.36 or later: `pip install "geomcore>=0.36"`, or, from a
source checkout, `PYTHONPATH=../geomcore/geomcore-py` (add `python` when running
from this repo, as in the Development section).

## API

| Call | Does |
|---|---|
| `gv.Viewer(title, view="auto"\|"2d"\|"3d", keep=False)` | a scene (new run) |
| `view.add(*objs, label=, group=, color=, width=, dashed=, opacity=, u=, v=, foci=, asymptotes=, …)` | show objects → `Handle` / list |
| `handle.update(color=…)`, `handle.remove()` | change or remove one object |
| `view.pcurve(curve, on=surface)` | a `Line2D`, `Circle2D` (e.g. `circle.parametrize_on(cyl)`) or `(u, v)` pairs drawn on a surface already added |
| `view.polyline(pts)`, `view.mesh(v, i)`, `view.arrow(at, vec)`, `view.text(at, s)` | raw geometry |
| `view.clear()`, `view.save(path)`, `view.open()` | housekeeping |
| `gv.add(...)`, `gv.clear()` | same, on the most recent viewer (handy in `pdb`) |
| `geomcore-viewer serve` / `geomcore-viewer stop` | run / stop the server by hand |

Default windows for infinite surfaces (planes, cylinders, cones) are computed
from the objects already added, so add the finite objects first or pass `u=`
and `v=`.

The server listens on `http://127.0.0.1:8765` by default. If that port is
busy, set `GEOMCORE_VIEWER_URL=http://127.0.0.1:<other port>` (every script
and `gv.add` picks it up; a started server listens on that port) or pass
`gv.Viewer(url=...)`. An explicit `url=` wins over the variable. A blank
variable counts as unset. A URL without a port means port 80, as `http://`
says. `geomcore-viewer serve` and `stop` take their default port from the same
variable; `--port` overrides it.

The server only answers requests addressed to its own `127.0.0.1:<port>` or
`localhost:<port>` (a browser safety rule), so to watch a remote machine's
viewer through SSH keep the same port on both ends:
`ssh -L 8765:127.0.0.1:8765 <host>`, then open `http://127.0.0.1:8765`.

## Drawing results

With geomcore 0.36 or later, pass a result object straight to `add`; there is
nothing to unpack. Supported: `CurveProjection`, `CurveProjection2D`,
`SurfaceProjection`, `CurveCurveIntersection`, `CurveCurveIntersection2D`,
`CurveSurfaceIntersection`, `SurfaceSurfaceIntersection` and
`CurveCurveExtrema`.

```python
from geomcore import Frame3D, Point3D, Vector3D
from geomcore.curves import Circle3D, Ellipse3D
import geomcore_viewer as gv

view = gv.Viewer("Results")
E = Ellipse3D.from_frame(Frame3D.world(), 3.0, 2.0)
C = Circle3D(Point3D(2, 1, 0), Vector3D.unit_z(), 1.5)

view.add(E.project_point(Point3D(4, 3, 0)), label="closest")  # projection
view.add(C.intersect(E), label="P")                           # intersection
```

Each result draws as one group named after its label (or after the operands
when there is none), the same group every time the script re-runs:

- the operands are faded and the result is drawn in an accent colour no
  automatic colour uses;
- a projection shows the query point, the closest point and a dashed connector
  labelled with the distance; the extrema of two curves show a dashed segment
  per minimum labelled `d = …`;
- an intersection shows its hit points (tangent hits are labelled), curves and
  overlaps, and a note with the method used (`method: …`) or `∅` when empty;
- a result that is not complete says so: a note with the reason, and a dashed
  wireframe box around each region that was not resolved;
- unbounded surfaces (planes, cylinders, cones) are windowed around the result
  instead of the whole scene.

Options you pass to `add` (`color=`, `dashed=`, `u=`, `v=`, …) win over these
defaults; `opacity=` applies to the operands.

## The page

The view shows the plane z = 0 when every object lies in it, else 3D; the
header's 2D/3D switch (or the scene's `view`) overrides that. A view that cannot
start (for example 3D without WebGL) has its 2D/3D button disabled, the `2`/`3`
keys do nothing for it, and the failure stays in the header's status line.

| Key | Does |
|---|---|
| `F` | fit the scene (and follow it again as it changes) |
| `P` | presentation mode: header and panel hidden, lines and labels ×1.5 |
| `T` | light / dark theme (remembered by the browser) |
| `2` / `3` | plane view / 3D view |
| `U` | show / hide the (u,v) pane |
| `Esc` | leave presentation mode, else clear the selection |

In the plane view, hover an object for its type, label, parameter `t`, and
`(x, y)`; intersection points also show the parameters of the hit
(`meta.params`). Click a point to copy its coordinates. Drag to pan and
scroll to zoom. The panel's checkboxes hide objects and whole groups, and
stay off when the script runs again. Click a row to frame that object.

In 3D, drag to orbit, right-drag to pan and scroll to zoom; the toolbar
switches between perspective and orthographic and snaps to the top, front,
right and iso views. Lines keep their pixel width at any distance, and
surfaces turn translucent when the scene also holds curves. Hover a curve
for its parameter `t` and point, a surface for its `(u, v)`.

The (u,v) pane, an inset of the 3D view, shows the selected surface (or the
surface of the selected pcurve, or of the first pcurve in the scene): its
window, seams and the pcurves on it. Hovering it puts a marker on the
surface in 3D; hovering the surface or a pcurve in 3D puts one in the pane.

## Rust

`cargo add geomcore-viewer --features geomcore` (crates.io; the feature takes
geomcore 0.36). `clients/rust` is the same client for Rust programs: `Viewer::add`, labels,
groups, runs and surface windows work as in Python, and with the `geomcore`
cargo feature geomcore's curves, surfaces, points and `parametrize_on` results
go straight to `add`. Rust never starts the server: run
`python -m geomcore_viewer serve` once. See [clients/rust/README.md](clients/rust/README.md).

## Layout

| Path | What |
|---|---|
| `protocol/SCENE.md` | protocol v2: the JSON every client and the viewer speak |
| `python/geomcore_viewer/` | client (`viewer.py`), geomcore adapter (`adapt.py`), server (`server.py`, `spawn.py`) |
| `frontend/` | Vite + TypeScript viewer (Babylon.js 3D, PixiJS 2D); `src/geom/` is the evaluator core, `src/view2d/` the plane view, `src/view3d/` the 3D view, `src/viewuv/` the (u,v) pane |
| `clients/rust/` | Rust client: `Viewer`, `Geom`, geomcore conversions behind the `geomcore` feature ([README](clients/rust/README.md)) |
| `examples/` | `conics_2d.py`, `quadrics_3d.py`, `pcurve.py` (each takes `--save <file>`); Rust: `clients/rust/examples/` |

## Development

```sh
python3 -m venv .venv && .venv/bin/pip install pytest
PYTHONPATH=python:../geomcore/geomcore-py .venv/bin/python -m pytest python/tests -q
cd frontend && npm ci && npm test && npm run build && cd ..
cd frontend && npx playwright install chromium && npm run e2e && cd ..   # browser tests (port 8797)
scripts/bundle-frontend.sh          # copy the build into the Python package
scripts/refresh-fixtures.sh         # re-vendor geomcore's golden fixtures
(cd clients/rust && cargo test --features geomcore)   # Rust client
scripts/rust-live-check.sh 8797     # Rust examples against a real server
```

Releasing: bump `version` in `python/pyproject.toml` and `clients/rust/Cargo.toml`, merge, then push a
`vX.Y.Z` tag. `.github/workflows/release.yml` checks that the tag matches both versions, publishes to
PyPI and crates.io through trusted publishing (no tokens), and attaches the files to the GitHub release.
Run it by hand with an existing tag to publish whatever of that version is not out yet.

## Live demo

<https://geomcore.github.io/geomcore-viewer/> — the bundled sample scene.

## License

Dual-licensed under MIT or Apache-2.0, at your option — same as `geomcore`.
