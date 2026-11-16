"""Sampling helpers: turn parametric geometry into viewer-ready payloads.

Everything is duck-typed on ``point_at``-style callables, so real
``geomcore`` objects plug in directly::

    circle = Circle(Point.origin(), Vector.unit_z(), 2.0)
    viewer.add_curve3d("circle", sample_curve(circle.point_at, 0.0, 2 * math.pi))

with no dependency on ``geomcore`` itself.
"""

from __future__ import annotations

from collections.abc import Callable


def sample_curve(
    eval_point,
    t0: float,
    t1: float,
    n: int = 128,
) -> list:
    """Sample ``eval_point(t)`` at ``n`` segments; points may be 2D or 3D."""
    pts = []
    for i in range(n + 1):
        t = t0 + (t1 - t0) * i / n
        p = eval_point(t)
        pts.append([p.x, p.y] if not hasattr(p, "z") else [p.x, p.y, p.z])
    return pts


def sample_surface_grid(
    eval_point: Callable[[float, float], object],
    u0: float,
    u1: float,
    v0: float,
    v1: float,
    nu: int = 48,
    nv: int = 24,
) -> tuple[list, list[int]]:
    """Sample ``eval_point(u, v)`` on a grid; returns ``(vertices, indices)``."""
    vertices: list = []
    for j in range(nv + 1):
        v = v0 + (v1 - v0) * j / nv
        for i in range(nu + 1):
            u = u0 + (u1 - u0) * i / nu
            p = eval_point(u, v)
            vertices.append([p.x, p.y, p.z])  # type: ignore[attr-defined]
    indices: list[int] = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            b = a + 1
            c = a + nu + 1
            d = c + 1
            indices += [a, c, b, b, c, d]
    return vertices, indices
