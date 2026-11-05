# Hidden lines, silhouettes and kernel iso curves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Docs iframes of kernel-computed scenes that read like the geomcore SVG figures: front lines solid, hidden lines dashed, silhouettes drawn, kernel iso curves as labeled objects.

**Architecture:** Two new surface extras (`hidden`, `silhouette`). The 3D view draws an invisible, stencil-tagged occluder per `hidden` surface after ordinary surfaces, then dashed twins of every line with a `GREATER` depth test where the stencil says "dashed", then the solid lines. Silhouettes are a CPU marching-squares contour of `n · (S − eye)` on the surface grid, recomputed when the camera moves. Python gains `u_iso` / `v_iso`; both clients send degenerate isos as points.

**Tech Stack:** TypeScript + Babylon.js 8 + vitest + Playwright (viewer), Python stdlib client + pytest, Rust client, PyO3 bindings (geomcore repo).

**Spec:** `docs/superpowers/specs/2026-10-13-hidden-lines-and-iso-curves-design.md`

## Global Constraints

- Scenes without `hidden` / `silhouette` render exactly as today (lines stay in rendering group 1, no twins).
- Unknown extra values are ignored (`hidden` other than `"dashed"` / `"hide"`, `silhouette` other than `true`).
- Radii stay strictly positive on the wire: degenerate isos travel as `point`.
- The viewer computes no intersections.
- The viewer repo has uncommitted phase-4 work in the same files: viewer-repo code changes stay uncommitted; the geomcore repo work goes on branch `feat/py-iso-bindings`.
- Python client stays stdlib-only.

## Review Focus

1. A curve lying exactly on a `hidden` surface (its own isolines, a pcurve) must stay solid where seen, not dashed (occluder `zOffset`) — e2e checks the front isolines of the torus keep the solid colour.
2. The silhouette of a sphere crossing its `u` seam must come back as one closed loop, not two pieces — unit test.
3. Orthographic camera: the silhouette uses the view direction, not the eye point — unit test.
4. An opaque ordinary surface in front of an occluder must hide lines completely (stencil stays 0) — covered by the stencil design; checked visually in the e2e scene's screenshot.
5. Toggling a `hidden` surface's visibility or removing it must restore today's rendering (rebuild when "occluding" changes) — handled in `flush`, checked manually.

---

### Task 1: Python bindings `u_iso` / `v_iso` (geomcore repo)

**Files:**
- Modify: `geomcore-py/src/lib.rs` (impl blocks of `PyPlane`, `PyCylinder`, `PyCone`, `PySphere`, `PyTorus`, `PyBSplineSurface`)
- Modify: `geomcore-py/geomcore/surfaces.pyi`
- Test: `geomcore-py/tests/test_bindings.py`
- Modify: `Cargo.toml` (workspace version 0.33.1), `CHANGELOG.md`

**Interfaces:** Produces `S.u_iso(u)` / `S.v_iso(v)` returning `Line3D` / `Circle3D` / `BSplineCurve3D` (Plane: Line/Line, Cylinder & Cone: Line/Circle, Sphere & Torus: Circle/Circle, BSplineSurface: BSplineCurve3D/BSplineCurve3D); `ValueError` on `SurfaceIsoError`.

- [ ] Step 1: tests

```python
ISO_SURFACES = [
    lambda: Plane(Point3D(1, 2, 3), Vector3D(0, 0, 1)),
    lambda: Cylinder(Point3D.origin(), Vector3D.z(), 2.0),
    lambda: Cone(Point3D.origin(), Vector3D.z(), 0.4, 1.0),
    lambda: Sphere(Point3D(1, 0, 0), 3.0),
    lambda: Torus(Point3D.origin(), Vector3D.z(), 5.0, 1.5),
    lambda: Sphere(Point3D.origin(), 2.0).to_bspline_patch((0.0, 3.0), (-1.0, 1.0)),
]

@pytest.mark.parametrize("make", ISO_SURFACES)
def test_iso_curves_follow_the_surface(make):
    s = make()
    u0, u1 = s.u_bounds(); v0, v1 = s.v_bounds()
    fin = lambda a, b, d: (a, b) if math.isfinite(a) and math.isfinite(b) else (-d, d)
    u0, u1 = fin(u0, u1, 2.0); v0, v1 = fin(v0, v1, 2.0)
    for k in (0.2, 0.5, 0.9):
        u, v = u0 + k * (u1 - u0), v0 + k * (v1 - v0)
        for t in (0.1, 0.6):
            assert_close(s.u_iso(u).eval_point(v0 + t * (v1 - v0)), s.eval_point(u, v0 + t * (v1 - v0)))
            assert_close(s.v_iso(v).eval_point(u0 + t * (u1 - u0)), s.eval_point(u0 + t * (u1 - u0), v))

def test_iso_curve_errors():
    with pytest.raises(ValueError):
        Sphere(Point3D.origin(), 1.0).u_iso(math.nan)
    patch = Sphere(Point3D.origin(), 2.0).to_bspline_patch((0.0, 3.0), (-1.0, 1.0))
    with pytest.raises(ValueError):
        patch.u_iso(10.0)

def test_a_pole_iso_is_a_point_circle():
    assert Sphere(Point3D.origin(), 1.0).v_iso(math.pi / 2).radius() == pytest.approx(0.0, abs=1e-12)
```

- [ ] Step 2: build (`cargo build --release -p geomcore-py`, copy `target/release/libgeomcore.so` to `geomcore-py/geomcore/geomcore.abi3.so`), run `PYTHONPATH=geomcore-py python3.11 -m pytest geomcore-py/tests -q -k iso` → FAIL (no attribute `u_iso`).
- [ ] Step 3: in each impl block, e.g. for the sphere:

```rust
    /// The `u` isoparametric circle (the meridian at `u`), parametrized by `v`
    /// like the sphere (raises `ValueError` for a non-finite `u`).
    fn u_iso(&self, u: f64) -> PyResult<PyCircle3D> {
        Ok(PyCircle3D(self.0.u_iso(u).map_err(val_err)?))
    }
```

and the stubs `def u_iso(self, u: float) -> Circle3D: ...`.
- [ ] Step 4: rebuild, run the whole `geomcore-py/tests` → PASS; `cargo clippy -p geomcore-py -- -D warnings`, `cargo fmt --check`.
- [ ] Step 5: version 0.33.1 + CHANGELOG entry; commit on `feat/py-iso-bindings`.

### Task 2: `geom/silhouette.ts`

**Files:** Create `frontend/src/geom/silhouette.ts`, `frontend/test/silhouette.test.ts`.

**Interfaces:**
- Consumes: `evalSurface(g, u, v): Vec3`, `SurfaceGrid` (`u`, `v`, `nu`, `nv`).
- Produces:

```ts
export interface Viewpoint { eye: Vec3; forward: Vec3; ortho: boolean }
export const SILHOUETTE_MAX = 96;
export function silhouette(g: SurfaceGeom, grid: SurfaceGrid, view: Viewpoint, tol: number): Vec3[][];
```

`f(u, v) = n̂ · (S − eye)` (perspective) or `n̂ · forward` (ortho), `n̂` the unit normal from central differences, evaluated a hair inside the window where `|S_u × S_v|` vanishes (poles, apex). Cells = `min(SILHOUETTE_MAX, max(8, n))` per direction. Marching squares (saddle by the centre's sign), each crossing edge refined once by bisection (cached per edge), segments chained by shared edge, then polylines whose ends meet within `tol` are joined (periodic seams).

- [ ] Step 1: tests — sphere r = 2 seen from (10, 0, 0): every point has |p| = 2 and x = r²/d = 0.4 (to 1e-6), one closed loop of length ≈ 2π·r·√(d² − r²)/d (1 %); orthographic forward (−1, 0, 0): x = 0; plane face-on: `[]`; cylinder r = 1, v ∈ [−1, 1], eye (10, 0, 0): two straight pieces at x = 0.1; torus R = 3, r = 1 from (0, 0, 20): two closed loops.
- [ ] Step 2: `npx vitest run test/silhouette.test.ts` → FAIL (module missing).
- [ ] Step 3: implement.
- [ ] Step 4: → PASS.

### Task 3: occluders, twins and silhouettes in `view3d/render.ts`

**Files:** Modify `frontend/src/view3d/render.ts`; test `frontend/test/render3d.test.ts`.

**Interfaces:** Produces

```ts
export type HiddenMode = "dashed" | "hide";
export const HIDDEN_PX = 0.7;      // hidden twin width factor
export const HIDDEN_ALPHA = 0.6;   // hidden twin alpha factor
export const SILHOUETTE_PX = 1.5;  // × EDGE_PX
export function hiddenMode(extras: Record<string, unknown> | undefined): HiddenMode | null;
export function sceneOccludes(objects: Iterable<SceneObject>): boolean;  // any analytic surface with a hidden mode
export interface Occluder3D { id: string; mesh: TriMesh; mode: HiddenMode }
export interface Silhouette3D { id: string; g: SurfaceGeom; grid: SurfaceGrid; color: string; alpha: number }
// ObjectDraw3D gains: occluder: Occluder3D | null; silhouette: Silhouette3D | null
// Lines3D gains: dashed: boolean  (extra or style.dashed: paths already dashed)
export function hiddenTwin(part: Lines3D, box: Box): Lines3D;   // dashed paths, px × HIDDEN_PX, alpha × HIDDEN_ALPHA
export function silhouetteLines(s: Silhouette3D, view: Viewpoint, box: Box): Lines3D | null;
```

- [ ] Step 1: tests — `hiddenMode` reads the two values, else null; `objectDraw3D` returns an occluder (mesh = the surface tessellation, same mode) only with `hidden`, a `silhouette` only with `silhouette: true`, nothing for `hidden: "other"`, nothing on a `mesh`; a `wire` + `hidden` torus has an occluder and no surface; `hiddenTwin` dashes a solid part (more paths) and keeps a dashed one; `silhouetteLines` for a sphere gives one part in the surface colour at `EDGE_PX * SILHOUETTE_PX`; `sceneOccludes`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: PASS (whole vitest suite).

### Task 4: stencil passes in `view3d/view.ts`

**Files:** Modify `frontend/src/view3d/view.ts`.

- `BABYLON.RenderingManager.MAX_RENDERINGGROUPS = 5` before any scene; engine `stencil: true`; groups 2, 3, 4 keep depth and stencil (`setRenderingAutoClearDepthStencil(g, false, false, false)`).
- `occludes` flag (from `sceneOccludes`) next to `withCurves`: a change rebuilds.
- When occluding: ordinary translucent surfaces don't write depth; occluder mesh (group 2): `disableColorWrite`, `zOffset = zOffsetUnits = 1`, `backFaceCulling = false`, stencil `ALWAYS` / ref 1 or 2 / `REPLACE` on depth pass; each line part's twin (group 3) built from `hiddenTwin`, colour mixed toward the background by `EXTRA_MIX`, `depthFunction = GREATER`, `disableDepthWrite`, stencil `EQUAL` ref 1, `KEEP`; solid lines in group 4.
- Silhouettes: `b.silhouette` lines rebuilt in `beforeRender` when the view matrix changed (flag set by `onViewMatrixChangedObservable`), same groups and twins; included in highlight, resize and visibility.
- [ ] Step 1: implement. Step 2: `npm run build` (tsc) passes.

### Task 5: e2e scene

**Files:** Create `frontend/e2e/scenes/hidden_lines.json`; modify `frontend/e2e/view3d.e2e.ts`.

Scene: torus R = 3, r = 1, `wire` + `hidden: "dashed"` + `silhouette: true`, colour `#3b6fd4`; a circle r = 3 in z = 0 (the tube's centre line, inside the tube: entirely hidden → only faint dashes) colour `#c0392b`; a circle r = 4.5 at z = 0 (outside, partly behind) colour `#2c7a3f`.

- [ ] Test: the green circle has solid pixels (> 100) and the red one has fewer solid-colour pixels than the green one but its faint colour (mixed toward the background) shows (> 20); with `hidden` removed (re-post), the red circle's solid pixels reappear.
- [ ] `npm run build && npx playwright test e2e/view3d.e2e.ts` (chromium path via `PLAYWRIGHT_CHROMIUM`).

### Task 6: clients and protocol docs

**Files:** `python/geomcore_viewer/viewer.py` (`EXTRA_KEYS`, docstring), `python/geomcore_viewer/adapt.py` (radius-0 circle and collapsed B-spline → point), `python/tests/test_adapt.py`; `clients/rust/Cargo.toml` (geomcore 0.33), `clients/rust/src/convert.rs` (same rule + tests with `Sphere::v_iso(PI/2)` and `BSplineSurface` collapsed edge); `protocol/SCENE.md`, `README.md`, `clients/rust/README.md`.

- [ ] Python tests with duck-typed fakes (radius 0 circle → `{"type": "point", "p": centre}`; B-spline whose poles coincide → point); `python3 -m pytest python/tests -q`.
- [ ] Rust: `cargo test --features geomcore`, `cargo clippy --all-targets --features geomcore -- -D warnings`, `cargo fmt --check`.

### Task 7: docs scenes (geomcore repo)

**Files:** `docs/assets/scenes/gen_scenes.py`, nine new `docs/assets/scenes/*.json`, `docs/guides/parametrization.md`, `docs/geometry/elementary.md`, `docs/guides/intersection.md`, `docs/nurbs/index.md`.

- [ ] One function per scene (spec §6), each `save`d; run with the local bindings and the local viewer client: `PYTHONPATH=geomcore-py:../geomcore-viewer/python python3.11 docs/assets/scenes/gen_scenes.py`.
- [ ] Load each JSON in the local viewer (`?scene=`) and look at it.
- [ ] An `<iframe>` under each SVG, same markup as the intersection guide's.
- [ ] Commit on `feat/py-iso-bindings` (or a docs branch on top).
