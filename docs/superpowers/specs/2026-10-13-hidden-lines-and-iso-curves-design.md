# Hidden lines, silhouettes and kernel iso curves

Date: 2026-10-13 · Status: approved design, pending spec review

## 1. Purpose

geomcore v0.33.0 extracts isoparametric curves from surfaces: `u_iso(u)`
fixes `u` and returns the curve running along `v`, `v_iso(v)` the one
running along `u`, each parametrized like the surface (a `Line3D`, a
`Circle3D` or a `BSplineCurve3D`). The geomcore docs illustrate surfaces with
hand-made SVG line drawings: isolines, silhouettes, curves on the surface,
with whatever the surface hides drawn dashed and faint.

This work lets the docs embed **interactive viewer scenes that read like
those figures** — computed by the real kernel in `gen_scenes.py`, orbitable
in an iframe — and makes the kernel's iso curves first-class objects in a
scene.

### Success criteria

1. A docs iframe of a `wire` torus shows its front isolines solid, its back
   isolines dashed and faint, its silhouette (outer and inner contour) drawn,
   and keeps all of that right while the user orbits.
2. A curve lying on (or behind) such a surface is solid where seen and
   dashed where the surface hides it, like curve A in
   `parametric-domain/06-three-curves-on-a-torus.svg`.
3. `S.u_iso(u)` / `S.v_iso(v)` from Python go into a scene with
   `view.add(...)`, labeled, exact and hoverable; a degenerate one (a pole,
   an apex, a pinch) arrives as a point instead of being rejected.
4. Scenes without the new extras render exactly as before.
5. Nine figures from the geomcore docs (§6) get a viewer iframe beside them.

### Non-goals

- No visible tessellation for line-art surfaces. An invisible depth-only
  mesh is allowed: it only decides which line fragments are hidden.
- The viewer still computes no intersections. Silhouettes are a display-time
  contour of an evaluated quantity (§3.3), like sampling.
- Not in this version: the docs palette in embeds, a scene-chosen initial
  camera, a chrome-less embed mode, annotations (angle arcs, dimension lines,
  triads), SVG export.

## 2. Protocol (`protocol/SCENE.md`)

Two new surface extras, combinable with each other and with `wire` /
`isolines`:

| Extra | Values | Effect |
|---|---|---|
| `hidden` | `"dashed"`, `"hide"` | The surface becomes an occluder for lines: lines (of any object, its own isolines and silhouette included) behind it are drawn dashed and faint (`"dashed"`) or not at all (`"hide"`). Absent: lines behind it are drawn as today. |
| `silhouette` | `true` | Draw the surface's view-dependent outline, recomputed as the camera moves. |

Like every other extra, an unknown value is ignored: `hidden` other than
`"dashed"` / `"hide"`, `silhouette` other than `true`.
Both apply to analytic surfaces only (`plane`, `cylinder`, `cone`, `sphere`,
`torus`, `bspline_surface`), not to `mesh`. The plane view (2D) ignores them.

The docs torus is
`"extras": {"wire": true, "hidden": "dashed", "silhouette": true}`.

Clients send a degenerate iso curve as a `point`: a `circle` of radius 0
(apex, pole, pinch) at its center, a `bspline_curve` whose poles all
coincide at that pole. Radii stay strictly positive on the wire.

## 3. Frontend

### 3.1 Pure part (`view3d/render.ts`, `geom/silhouette.ts`)

`objectDraw3D` gains, for a surface with `hidden`:

```ts
occluder: { mesh: TriMesh; mode: "dashed" | "hide" } | null
```

— the same grid tessellation as `tessellateSurface(g, grid)`, which the
view never shows. A surface with `silhouette: true` sets
`silhouette: { grid: SurfaceGrid }` so the view can contour it per camera.
`Lines3D` gains nothing; every line part gets a hidden-pass twin in the view
when the scene has an occluder in `"dashed"` mode (§3.2).

### 3.2 Draw order and passes (`view3d/view.ts`)

The engine is created with `stencil: true` (today `false`).

| Group | Content | Depth | Stencil |
|---|---|---|---|
| 0 | ground grid (as today) | no write | — |
| 1 | ordinary surfaces, meshes, markers (as today) | test + write | — |
| 2 (depth kept from 1) | occluders: colour writes off | test + write, slope-scaled `zOffset` like today's surfaces | on depth pass: replace with 1 (`dashed`) or 2 (`hide`) |
| 2 | solid lines (today's line meshes) | test `LEQUAL` | — |
| 2 | hidden lines | test `GREATER`, no write | pass only where stencil = 1 |

Why it is exact per surface: an occluder that passes the depth test is
nearer than everything drawn before it at that pixel, so after all occluders
the stencil holds the mode of the **nearest** one. Lines behind an opaque
ordinary surface fail there (the occluder behind it failed depth, stencil
stays 0); lines behind a `"hide"` occluder see stencil 2. Occluders, drawn
after group 1, never hide ordinary surfaces.

A scene with no occluder draws exactly as today: lines stay in group 1 and
get no twins. Markers and labels are never hidden by an occluder (a curve's
end point behind a surface stays a solid dot, as in the figures).

Hidden-line style: the paths cut by the existing `dashPolyline` (`DASH`,
world units), width × 0.7, colour mixed toward the background (as extras
are, `EXTRA_MIX`), alpha × 0.6. A part already `dashed` or `extra` keeps its
dashes in both passes.

Hover and picking are unchanged (world polylines): a hidden piece stays
hoverable.

### 3.3 Silhouettes (`geom/silhouette.ts`)

```ts
silhouette(g: SurfaceGeom, grid: SurfaceGrid, eye: Vec3, tol: number): Vec3[][]
```

1. On the surface grid (each direction capped at 96 segments) evaluate
   `f(u, v) = (S_u × S_v) · (S(u, v) − eye)`, the partials by central
   differences of `evalSurface`.
2. Marching squares on the sign of `f`; an ambiguous cell takes the sign of
   its centre. Cells where `|S_u × S_v|` is below `1e-12 ×` its grid maximum
   (a pole, an apex) are skipped.
3. Each edge crossing is refined by bisection on the exact `f` until the
   points move less than `tol`.
4. Crossings are chained into polylines across cells (and across the seam of
   a periodic direction) and lifted with `evalSurface`.

A plane yields nothing unless seen edge-on (its `f` keeps one sign). The
view recomputes silhouettes in `beforeRender` when the view matrix changed,
and replaces those line meshes (solid and hidden twins). Silhouettes use the
surface's colour at `EDGE_PX × 1.5`.

### 3.4 Risks

- **Line on its own occluder.** An isoline lies exactly on the surface
  that hides others; the occluder's slope-scaled `zOffset` keeps it solid.
  Near the silhouette (grazing) it may speckle: check visually on the torus
  and sphere scenes, raise `zOffsetUnits` if needed.
- **Dash phase.** Dashes are cut on the CPU, so they do not restart where a
  line turns hidden. The figures share this.
- **Cost.** Two line meshes per line part when a dashed occluder exists;
  silhouettes ≤ 97 × 97 evaluations per surface per camera move.

## 4. Clients

### 4.1 Python bindings (geomcore repo, `geomcore-py`)

`u_iso(u)` and `v_iso(v)` on `Plane`, `Cylinder`, `Cone`, `Sphere`, `Torus`
and `BSplineSurface`, returning the bound `Line3D`, `Circle3D` or
`BSplineCurve3D`; `SurfaceIsoError` → `ValueError`. Released as geomcore
0.33.1 (bindings for 0.33 APIs, as 0.32.2 was for 0.32). Tests: for several
`u`, `v`, `t`, `iso.eval_point(t)` equals `S.eval_point(u, t)` /
`S.eval_point(t, v)` to 1e-12; a NaN parameter and a B-spline parameter
outside a non-periodic domain raise `ValueError`; a periodic one wraps.

### 4.2 Python viewer client

- `EXTRA_KEYS` gains `hidden` and `silhouette`; `add`'s docstring lists them.
- `adapt.py`: a `Circle3D` of radius 0 → `point` at its centre; a
  `BSplineCurve3D` whose poles all coincide → `point`.
- A featured iso also shown in the (u, v) pane is an ordinary `pcurve`
  (the line u = const in (u, v)); no new API.

### 4.3 Rust client

`convert.rs` applies the same degenerate rule to `Circle3D` and
`BSplineCurve3D` (and so to a `Curve3D` from `Surface::u_iso`). Extras need
nothing: `Opts::extra("hidden", "dashed")`.

## 5. Docs in this repo

`protocol/SCENE.md` (the two extras, the degenerate rule), the README's
extras list, `clients/rust/README.md`.

## 6. Docs scenes (geomcore repo)

`docs/assets/scenes/gen_scenes.py` gains one scene per figure, each
surface `wire` + `hidden: "dashed"` + `silhouette: true`, featured isos from
`u_iso` / `v_iso`, labeled as in the figure. Each iframe goes right under its
SVG (the SVGs stay: no JavaScript needed, they print).

| Page | Figure | Scene |
|---|---|---|
| guides/parametrization | 02, 04, 05, 06: three curves on a cylinder, cone, sphere, torus | the surface; A: `v_iso`, B: `u_iso`, C: a winding `pcurve`; A and B also as `pcurve`s so the (u, v) pane mirrors the figure's right half |
| guides/parametrization | 01: a uniform grid on a sphere | the sphere with `isolines`; the equator cell and the pole cell as narrow-window translucent spheres |
| geometry/elementary | 15, 16: a sphere / torus with a point resolved | the surface, `P(u, v)`, its `u_iso` and `v_iso` through P |
| guides/intersection | 16: plane and sphere | three spheres side by side (δ = 0.5, r, 1.4), each with its translucent plane and the kernel's intersection (ring, point, nothing) |
| nurbs/index | 13: a surface and one raised point (not on any page yet: the SVG and the iframe go after "Moving one control point") | the B-spline surface with `isolines`, its control net as polylines, the raised pole, the region that moves as a narrow-window translucent copy |

The iframes need the updated viewer deployed to
`geomcore.github.io/geomcore-viewer`; until then the new extras are ignored
and surfaces show as plain wireframes.

## 7. Phases

1. **Bindings** (geomcore repo): `u_iso` / `v_iso` in `geomcore-py`, tests,
   0.33.1.
2. **Viewer**: protocol validation of the extras, `geom/silhouette.ts`,
   occluder and silhouette in `objectDraw3D`, stencil passes in the view.
3. **Clients**: Python and Rust degenerate rule, `EXTRA_KEYS`, docs (§5).
4. **Docs scenes** (geomcore repo): the nine scenes and iframes, after the
   viewer is deployed.

## 8. Testing

- `silhouette.test.ts`: a sphere's silhouette from an eye at distance `d`
  is the circle of radius `r·√(d² − r²)/d` at distance `r²/d` from the
  centre (within `tol`); a torus seen obliquely gives the expected number of
  loops; a plane seen face-on gives none; a cylinder's are two generators.
- `render3d.test.ts`: `objectDraw3D` returns an occluder with the right mode
  only when `hidden` is set, a silhouette grid only with `silhouette: true`,
  and nothing new otherwise.
- `protocol.test.ts`: the extras parse; `render3d.test.ts`: `hidden: "other"`
  makes no occluder.
- e2e: `e2e/scenes/hidden-lines.json` (a `wire` torus with a curve passing
  behind it); the 3D canvas has dashed back isolines and the curve's hidden
  part in the faint colour.
- Python and Rust: a radius-0 circle and a collapsed B-spline curve become
  `point`s; `EXTRA_KEYS` passes `hidden` / `silhouette` through.
- geomcore-py: §4.1.
