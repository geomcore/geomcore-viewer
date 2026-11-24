# geomcore-viewer

Display [geomcore](https://github.com/geomcore/geomcore) geometry in your
browser from a Python script, debugger or notebook.

```sh
pip install geomcore-viewer
```

The Python package supports geomcore 0.44 through 0.47.

```python
# conics.py — run with: python conics.py   (re-run after every edit)
from geomcore import Circle, Ellipse, Frame, Point, Vector
import geomcore_viewer as gv

view = gv.Viewer("Ellipse ∩ circle")
E = Ellipse.from_frame(Frame.world(), 3.0, 2.0)
C = Circle(Point(2, 1, 0), Vector.unit_z(), 1.5)

view.add(E, label="E")
view.add(C, label="C")
view.add(C.intersect(E), label="P")   # → P₁, P₂
```

The first `add` starts the local server and opens the viewer. Re-running
the script replaces the scene in the same tab. Within a run, reusing a label
updates that object. To share a scene, call `view.save("scene.json")` and
drop the file onto the [hosted viewer](https://geomcore.github.io/geomcore-viewer/).

## API

| Call | Does |
|---|---|
| `gv.Viewer(title, view="auto"\|"2d"\|"3d", keep=False)` | a scene (new run) |
| `view.add(*objs, label=, group=, color=, width=, dashed=, opacity=, u=, v=, foci=, asymptotes=, …)` | show objects → `Handle` / list |
| `handle.update(color=…)`, `handle.remove()` | change or remove one object |
| `view.pcurve(curve, on=surface)` | a 2D curve or `(u, v)` pairs on a surface already added |
| `view.polyline(pts)`, `view.mesh(v, i)`, `view.arrow(at, vec)`, `view.text(at, s)` | raw geometry |
| `view.step(name)`, `view.batch()` | group objects into lesson steps or send them in one update |
| `view.points(xyz, values=...)` | display a point cloud coloured by scalar values |
| `view.clear()`, `view.save(path)`, `view.open()` | housekeeping |
| `gv.add(...)`, `gv.clear()` | same, on the most recent viewer (handy in `pdb`) |
| `geomcore-viewer serve` / `geomcore-viewer stop` | run / stop the server by hand |

The server listens on `http://127.0.0.1:8765` by default; set
`GEOMCORE_VIEWER_URL` to use another port. The full guide (remote machines over
SSH, the plane and 3D views, the (u, v) pane, the scene protocol and the Rust
client) is in the [repository README](https://github.com/geomcore/geomcore-viewer#readme).

Licensed under either of MIT or Apache-2.0, at your option.
