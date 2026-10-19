# Changelog

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
