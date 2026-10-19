# geomcore-viewer (Rust client)

Show geometry live in the [geomcore-viewer](https://github.com/geomcore/geomcore-viewer#readme) browser tab from Rust.
It speaks scene protocol v2 ([`protocol/SCENE.md`](https://github.com/geomcore/geomcore-viewer/blob/main/protocol/SCENE.md)), the same as the Python client.

```toml
[dependencies]
geomcore-viewer = { version = "0.3", features = ["geomcore"] }   # the feature needs geomcore 0.36
```

```rust
use geomcore::{Circle3D, Cylinder, Point3D, Tolerance, Vector3D};
use geomcore_viewer::{Geom, Opts, Viewer};

let mut view = Viewer::new("A circle on a cylinder")?;
let cylinder = Cylinder::new(Point3D::ORIGIN, Vector3D::Z, 2.0)?;
let ring = Circle3D::new(Point3D::new(0.0, 0.0, 1.0), Vector3D::Z, 2.0)?;
let s = view.add(Geom::from(&cylinder).window(None, Some([-2.0, 2.0])), Opts::new().label("S"))?;
view.add(&ring, Opts::new().label("C"))?;
view.pcurve(&ring.parametrize_on(cylinder, Tolerance::DEFAULT)?, &s, Opts::new().label("C in (u, v)"))?;
```

The viewer server is Python's, and Rust never starts it. Run
`python -m geomcore_viewer serve` once (any Python script using the viewer starts it too).
If no server answers, the client warns once on stderr and keeps the objects;
`view.save("scene.json")` still works.

| Call | Does |
|---|---|
| `Viewer::new(title)`, `Viewer::builder(title).view(ViewMode::Space).keep(true).url(..).build()` | a scene (a new run) |
| `view.add(geom, Opts::new().label("E").group("g").color("#d1495b").width(3.0).dashed(true).opacity(0.5).extra("foci", true))` | show one object → `Handle` |
| `view.add_all(points, Opts::new().label("P"))` | several objects labelled `P₁`, `P₂`, … (an empty list adds the note `P: ∅`) |
| `view.pcurve(curve_2d, &surface_handle, opts)` | a curve in the surface's (u, v) space |
| `view.update(&h, Style::new().color("red"))`, `view.remove(&h)` | change or remove one object |
| `view.clear()`, `view.scene()`, `view.save(path)` | housekeeping |

`Geom` has one variant per protocol type (`Geom::circle(frame, r)`, `.range(t0, t1)` on curves,
`.window(u, v)` on surfaces). With the `geomcore` feature (Rust 1.85+), geomcore's curves,
surfaces, points and `parametrize_on` results convert with `Geom::from(&x)` or pass straight
to `add`. B-splines are sampled: a curve as a 256-segment polyline, a surface as a 48 × 48 mesh.
Intersection results are not mapped; add their points with `add_all`.

`GEOMCORE_VIEWER_URL` picks the server, as for Python (default `http://127.0.0.1:8765`;
a URL without a port means port 80).

Examples (start a server first): `cargo run --example conics --features geomcore`,
`cargo run --example pcurve --features geomcore`; add `-- --save scene.json` to also write the scene to a file.
