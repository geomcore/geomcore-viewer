# Scene protocol (v2)

One JSON document spoken by the Python and Rust clients, the local server,
and the browser viewer. Clients send **analytic definitions** — the same
parameters geomcore stores — and the viewer evaluates them for display.
The viewer never computes intersections or any other geometric query.

## Document

```json
{
  "version": 2,
  "title": "Ellipse ∩ circle",
  "run": "a1b2c3d4e5f6",
  "view": "auto",
  "frames": ["tilt 0°", "tilt 45°"],
  "objects": [
    {
      "id": "E", "label": "E", "group": "conics", "source": "Ellipse3D",
      "geom": {
        "type": "ellipse",
        "frame": {"o": [0, 0, 0], "x": [1, 0, 0], "y": [0, 1, 0], "z": [0, 0, 1]},
        "a": 3, "b": 2
      },
      "style": {"color": "#d1495b", "width": 3, "dashed": false, "opacity": 1},
      "extras": {"foci": true}
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | unique, stable across updates; re-sending an `id` replaces the object |
| `geom` | yes | geometry, `geom.type` selects the shape (table below) |
| `label` | no | display name (panel, point labels) |
| `group` | no | panel grouping / visibility toggle |
| `source` | no | client-side type name, e.g. `Ellipse3D` |
| `frame` | no | lesson frame the object belongs to; the page shows one frame at a time, objects without a frame show in every frame |
| `style` | no | `color` (CSS), `width` (px), `dashed`, `opacity` (0–1; surfaces and meshes default to 0.45 when the scene holds a curve, polyline or pcurve, else 1) |
| `extras` | no | curves: `foci`, `center`, `axes`, `asymptotes`, `directrix`, `vertex`; B-spline/Bézier curves: `poles` (array of points → control polygon and dots), `knots` (array of points → dots), `comb` (`{scale, teeth: [[base, tip], …]}` → teeth and their envelope); surfaces: `isolines: [nu, nv]` (or `true` for 12 × 6; drawn at the middle of each cell of the window), `wire` (lines only: the isolines, 24 × 12 by default, and the window's edges), `normals` (array of `[base, tip]` segments). The Python client computes the point/segment arrays from the exact geomcore object (`poles=True`, `knots=True`, `comb=scale`, `normals=n`); the page draws them as extras. Unknown extras are ignored. |
| `meta` | no | free-form client data. The Python client sets `tag` (the intersection result's tag, e.g. `"points"`) and `params` (the numbers of the hit, e.g. `[t, s]` for `(t, P, s)`; a non-finite one is `null`); the 2D tooltip shows `params`. `operand: true` marks a result's operand or projection target: the views draw no label for it (hovering still names it). |

`view` is `"auto"`, `"2d"` or `"3d"`. `frames` is the ordered list of
lesson frames (the page's slider and ←/→ browse it); a new run with
`keep: false` clears it. Vectors are `[x, y, z]`; a 2-component vector is
read as `[x, y, 0]`. Every `frame` carries all three unit axes `o, x, y, z`
(right-handed, orthonormal).

## Geometry types

| `type` | Fields | Parametrization (identical to geomcore) |
|---|---|---|
| `line` | `o`, `d` | `o + t·d` |
| `circle` | `frame`, `r` | `o + r cos t·x + r sin t·y` |
| `ellipse` | `frame`, `a`, `b` | `o + a cos t·x + b sin t·y` |
| `parabola` | `frame`, `f` | `o + (t²/4f)·x + t·y` (o = apex) |
| `hyperbola` | `frame`, `a`, `b` | `o + a cosh t·x + b sinh t·y` (one branch) |
| `polyline` | `points` | as given |
| `plane` | `frame` | `o + u·x + v·y` |
| `cylinder` | `frame`, `r` | `o + r cos u·x + r sin u·y + v·z` |
| `cone` | `frame`, `semi_angle`, `ref_radius` | `R = ref_radius + v sin φ`; `o + R cos u·x + R sin u·y + v cos φ·z` |
| `sphere` | `frame`, `r` | `o + r cos v cos u·x + r cos v sin u·y + r sin v·z` |
| `torus` | `frame`, `R`, `r` | `ρ = R + r cos v`; `o + ρ cos u·x + ρ sin u·y + r sin v·z` |
| `extrusion` | `profile`, `direction` | `profile(u) + v·direction` |
| `revolution` | `profile`, `origin`, `direction` | `profile(v)` rotated about the axis (`origin`, `direction`) by `u` (Rodrigues); u is the angle |
| `mesh` | `vertices`, `indices`, `values?`, `colormap?` | triangles; `indices.length % 3 == 0` |
| `point` | `p` | — |
| `points` | `positions`, `size?`, `values?`, `colormap?` | point cloud |
| `arrow` | `at`, `vec` | — |
| `text` | `at`, `text` | — |
| `note` | `text`, `level?` (`info` / `warn`) | panel only, e.g. `P: ∅ (parallel)` |
| `pcurve` | `surface`, `curve` | `S(q(t))`: `surface` is a surface object's `id`; `curve` is a `line`, `circle` or `polyline` in z = 0 whose x is u and y is v |

Reserved for when geomcore exposes B-spline getters (clients send
`polyline` / `mesh` until then): `bspline_curve`, `bspline_surface`.

`extrusion.profile` and `revolution.profile` are any curve type above or a
`polyline`. A polyline profile may carry `range: [t0, t1]` (t0 ≠ t1): its
points are then spaced evenly over that parameter interval, which is how a
sampled B-spline or Bézier profile keeps the kernel's parametrization.
Without `range` its parameter is the point index (segment `i` spans
`t ∈ [i, i + 1]`, as in a `pcurve`). A revolution's `direction` is the axis
direction and must be non-zero.

### Scalar colouring

`points` and `mesh` may carry `values`: one finite number per point (or per
vertex, for a mesh), the same length as `positions` / `vertices`, with a
`colormap` name. The viewer normalizes the values over the object's own
minimum…maximum (a constant field sits in the middle) and colours each dot or
vertex. Maps: `viridis` (the default), `plasma`, `turbo`, `coolwarm`, `gray`;
an unknown name falls back to viridis. `colormap` without `values` is rejected.

Radii (`r`, `a`, `b`, `R`) must be positive and `f` non-zero.

### Ranges and windows

- Curves may carry `range: [t0, t1]`. Without it, `circle`/`ellipse` draw
  one full period; `line`/`parabola`/`hyperbola` are infinite and the
  viewer draws the part that crosses the visible region.
- Surfaces carry `window: {"u": [a, b], "v": [a, b]}`. Closed directions
  default to their full period (`cylinder`/`cone` u, `sphere` u and
  v ∈ [-π/2, π/2], `torus` u and v, `revolution` u); infinite directions
  (`plane` u/v, `cylinder`/`cone` v, `extrusion` u/v for an unbounded
  profile and v, `revolution` v for an unbounded profile) should always be
  given. When one is missing the viewer draws it over ±the half-size of the
  scene's view box (1.5 × the scene's half-extent, at least 1) and does not
  flag the object. A swept profile's parameter is not a length, so that
  half-size is converted: ÷|d| for a `line`, `min(h, 2√(|f|·h))` for a
  `parabola`, `asinh(h / max(a, b))` for a `hyperbola`, and an extrusion's
  sweep v is ÷|direction|. The Python client always fills `window` itself, from the
  objects already added (and from a profile's own bounds for
  `extrusion`/`revolution`: u for an extrusion, v for a revolution).
- A `pcurve` takes its surface's window. A `line` or `circle` is clipped
  to it in the directions that do not wrap, so a helix on a cylinder winds
  round the seam until it leaves the v window; one those leave unbounded
  (the line v = 3 a circle gives on a cylinder) is clipped to the whole
  window, one turn. Where both directions wrap (a torus), a line runs from
  where it enters the window (shifted by whole periods if it misses it)
  until u and v have each advanced by a whole number of periods, so it
  closes (at most 32 turns when its slope never closes). A `polyline` is
  drawn whole, point to point on the surface. `range` on a (u, v) line or
  circle narrows what is drawn, as for other curves; a `polyline` ignores
  it. A pcurve adds nothing to the view box, and while its `surface` names
  no surface it is kept but not drawn, and the
  panel flags it.

## Runs

Every client session has a `run` id. When the server receives objects with
a `run` it has not seen, it empties the scene first (unless `keep: true`)
and broadcasts a `run` event. The page keeps showing the previous picture
until the first `upsert` of the new run, then swaps — so re-running a
script never flashes an empty view, and a camera you have moved stays where
you left it (auto-fit follows the scene only until you orbit, pan or zoom;
the "fit" button or toggling auto-fit hands the camera back).

## Local server API

| Method | Path | Body | Effect |
|---|---|---|---|
| `GET` | `/api/health` | — | `{"app": "geomcore-viewer", "protocol": 2}` |
| `GET` | `/api/scene` | — | full document |
| `POST` | `/api/objects` | `{"run"?, "keep"?, "title"?, "view"?, "objects": [...]}` | upsert by `id` |
| `DELETE` | `/api/objects/{id}` | — | remove (404 if absent) |
| `POST` | `/api/clear` | — | empty scene |
| `POST` | `/api/shutdown` | — | stop the server |
| `GET` | `/events` | — | SSE: `scene`, then `run`, `upsert`, `remove`, `clear` |

### Events

Every `/events` connection (first connect and every automatic reconnect)
starts with `{"type": "scene", "doc": <full document>}`, taken under the
same lock that registers the subscriber, so no change can fall between the
snapshot and the events that follow it. The viewer treats `scene` as a full
replace (a reset: any pending run swap is dropped). The other events are
deltas on top of it:

| `type` | Fields |
|---|---|
| `scene` | `doc` |
| `run` | `run`, `keep` |
| `upsert` | `objects`, `title`, `view` |
| `remove` | `id` |
| `clear` | — |

Clients ignore event types they do not know.

Every `POST` must send `Content-Type: application/json` (anything else
gets `415`). Any website can make a browser call `127.0.0.1`, so the server
only answers requests from itself: the `Host` header must be
`127.0.0.1:<port>` or `localhost:<port>` (bare `127.0.0.1` or `localhost`
too on port 80, where browsers leave the port out), and an `Origin` header,
when present, must be `http://` followed by one of those; otherwise `403`
with `{"error": …, "app": "geomcore-viewer"}`, so a client can tell this
refusal from another program. An SSH tunnel must therefore keep the port:
`ssh -L 8765:127.0.0.1:8765 <host>`. It sends no CORS headers and answers no preflight, so other
origins can neither read nor write. Non-browser clients (Python, Rust, curl)
send no `Origin`; they just need the JSON content type and a `Host` with the
port.

The server binds `127.0.0.1`, is stdlib-only, and validates shape only
(`id` string, `geom.type` string); geometric validity is checked by the
viewer, which lists rejected objects in its panel.

## Compatibility

- v1 documents (`"version": 1`, `entities`) still load: `curve3d`/`curve2d`
  → `polyline`, `surface` → `mesh` (with `opacity`), `points3d`/`points2d`
  → `points`, `name` → `label`, `color` → `style.color`.
- The server takes v2 objects only: the v1 endpoint `POST /api/add` is gone
  (both clients speak v2), and `/api/objects` rejects v1 entities with `400`.
- Unknown `geom.type` → the object is skipped and listed as a problem.
- Any other `version` → nothing is drawn and the page says why.

Static fallbacks, in priority order: `?scene=<url>`, a live local server,
a drag-dropped `.json` file, the bundled `sample-scene.json`.
