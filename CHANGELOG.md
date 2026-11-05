# Changelog

## 0.4.0 - 2026-11-05

Draws objects from geomcore 0.39 and later, whose classes were renamed
(`Point`, `Circle`, `BSplineCurve`…); 0.3.0 rejected every one of them. The
older names still work. Tested with geomcore 0.43; the result classes still
need geomcore 0.36 or later.

### Added

- B-spline and Bézier curves and surfaces, 2D included, travel exact (degree,
  poles, weights, knots, multiplicities, periodicity; a Bézier through
  `to_bspline()`) and the page evaluates them with de Boor, so trimmed pieces
  keep their `range` and the display refines with the zoom. `resolution=` on
  `add` samples them instead.
- `add` takes the 2D conics, Bézier curves and surfaces, extrusions and
  revolutions (sent as their profile plus the sweep), and bounding boxes
  (drawn as their twelve edges, also `view.box(min, max)`).
- `hidden="dashed"` / `hidden="hide"` on a surface draws the lines behind it
  dashed and faint, or not at all; `silhouette=True` draws its outline from
  the camera. An iso curve that collapses to a point (a pole, an apex) is
  drawn as a point.
- Teaching extras: `poles=`, `knots=`, `comb=` on B-spline curves and
  `normals=` on surfaces.
- `view.points(xyz, values=, colormap=)` for point clouds, and `values=` /
  `colormap=` on `view.mesh`, colour per point or vertex.
- `with view.step("…"): …` makes lesson steps, browsed with a slider and ←/→.
- `with view.batch(): …` sends a block in one request; `polyline`, `arrow`
  and `text` take lists.
- Result displays reuse an operand already in the scene instead of drawing it
  again; `operands=False` leaves all operands out.
- A header checkbox hides labels; result operands draw no labels of their
  own in 3D.
- A tangent hit shows its name and that it is tangent.
- `pcurve` takes every 2D curve: lines, circles and trimmed pieces of them
  exactly, the rest sampled.
- The page has a favicon.
- The Rust client sends B-splines exact and has `Geom::bbox`.

### Changed

- Labels and the panel show the class name you used.
- Trimmed curves stay exact (`range`) instead of being sampled.
- A `BSplineSurface` draws its own knot domain unless `u=` / `v=` narrows it.

### Fixed

- geomcore 0.39+ objects are drawn (#15).
- Trimmed curves and the other inputs the README promised are accepted (#16).
- B-spline surfaces no longer need `u=` and `v=` (#18).

## 0.3.0 - 2026-10-19

Needs geomcore 0.36 or later for the result classes below; everything else,
including the `(tag, payload)` intersection results, still works with
geomcore 0.35 and earlier.

### Added

- `view.add(result)` draws geomcore 0.36 results directly: `CurveProjection`,
  `CurveProjection2D`, `SurfaceProjection`, `CurveCurveIntersection`,
  `CurveCurveIntersection2D`, `CurveSurfaceIntersection`,
  `SurfaceSurfaceIntersection` and `CurveCurveExtrema`.
- Result displays: operands faded, the result in an accent colour, a dashed
  connector with distance labels, notes for the method and status, dashed
  wireframe boxes for regions that were not resolved, unbounded surfaces
  windowed around the result, and one deterministic group per result.
  Options given to `add` win over the defaults.

### Changed

- Parts built by `_build` accept a group and a style of their own.
- `PALETTE` moved to `geomcore_viewer.adapt`; `geomcore_viewer.viewer` still
  re-exports it.
- The Rust client's `geomcore` feature takes geomcore 0.36 (was 0.32).

## 0.2.0

Protocol v2, the Rust client rewrite, the plane and (u,v) views and the
`serve` / `stop` commands. See the git history.
