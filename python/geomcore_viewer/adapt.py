"""Turn geomcore objects and intersection results into protocol-v2 geometry.

Dispatch is by class name + duck typing, so this module never imports
geomcore. geomcore-py exposes radii and centers but not orientation, so
analytic frames are recovered by evaluating the object at known parameters
(the parametrizations in protocol/SCENE.md, identical to geomcore's). Every
recovered geometry is re-evaluated at an extra parameter and compared with
``eval_point``: a convention mismatch raises instead of drawing a wrong
shape. B-splines go native (degree, poles, weights, knots, multiplicities,
periodicity) and are likewise re-evaluated through the de Boor evaluator in
this module; trimmed B-splines add ``range``.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

from .sampling import sample_curve, sample_surface_grid

TAU = 2.0 * math.pi
PALETTE = ("#d1495b", "#00798c", "#c47f00", "#3a7cc2", "#8a5cc2", "#5c8a00", "#b5448f", "#6b7a8f")
# Outside the cycled PALETTE, so no object is ever auto-coloured like a projection's highlights.
ACCENT = "#e8590c"
QUERY_POINT_COLOR = "#4b5563"
CHECK_TOL = 1e-9
_CHECK_T = 0.7
_CHECK_UV = (0.7, 0.3)
_BSPLINE_SEGMENTS = 256
_BSPLINE_GRID = 48
_WINDOW_MIN_HALF_SIZE = 1.0
_WINDOW_DISTANCE_FACTOR = 1.5

CURVES = frozenset({"Line3D", "Line2D", "Circle3D", "Circle2D", "Ellipse3D", "Parabola3D", "Hyperbola3D"})
SURFACES = frozenset({"Plane", "Cylinder", "Cone", "Sphere", "Torus"})
POINTS = frozenset({"Point3D", "Point2D"})
SAMPLED = frozenset({"BSplineCurve3D", "BSplineSurface"})
TRIMMED = frozenset({"TrimmedCurve3D", "TrimmedCurve2D"})
BOXES = frozenset({"BoundingBox3D"})
GEOMETRY = CURVES | SURFACES | POINTS | SAMPLED | TRIMMED | BOXES
SURFACE_TYPES = frozenset({"plane", "cylinder", "cone", "sphere", "torus", "bspline_surface"})

POINT_TAGS = frozenset({"point", "one_point", "tangent_point", "apex_point", "two_points", "points", "hits"})
CURVE_TAGS = frozenset({
    "line", "two_lines", "tangent_line", "circle", "two_circles", "tangent_circle", "ellipse", "parabola", "hyperbola",
})
EMPTY_NOTES = {"empty": "∅", "parallel": "∅ (parallel)", "skew": "∅ (skew)"}
INFO_NOTES = {
    "coincident": "coincident",
    "tangent": "tangent",
    "tangent_point": "tangent",
    "tangent_line": "tangent",
    "tangent_circle": "tangent",
    "apex_point": "through the apex",
}

# Full periods of closed parameter directions, and which directions are infinite.
_FULL_PERIOD = {
    "plane": {},
    "cylinder": {"u": [0.0, TAU]},
    "cone": {"u": [0.0, TAU]},
    "sphere": {"u": [0.0, TAU], "v": [-math.pi / 2, math.pi / 2]},
    "torus": {"u": [0.0, TAU], "v": [0.0, TAU]},
}
_INFINITE = {"plane": ("u", "v"), "cylinder": ("v",), "cone": ("v",), "sphere": (), "torus": ()}

_SUBSCRIPTS = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")


_SUBSCRIPT_DIGITS = frozenset("₀₁₂₃₄₅₆₇₈₉")


def subscript(i: int) -> str:
    return str(i).translate(_SUBSCRIPTS)


def indexed(label: str, i: int) -> str:
    """``P`` → ``P₃``; a label that already ends in a subscript gets a comma, ``P₁`` → ``P₁,₃``,
    so the 3rd point of ``P₁`` cannot collide with the 13th argument ``P₁₃``."""
    return f"{label},{subscript(i)}" if label[-1:] in _SUBSCRIPT_DIGITS else f"{label}{subscript(i)}"


# --- vectors ---------------------------------------------------------------
def as_vec(p) -> list[float]:
    """Point3D / Point2D / Vector2D / Vector3D / sequence → ``[x, y, z]`` floats."""
    if hasattr(p, "components"):  # Vector3D: .x is a static constructor there
        c = list(p.components())
    elif hasattr(p, "x") and not callable(p.x):
        c = [p.x, p.y, getattr(p, "z", 0.0)]
    else:
        c = list(p)
    if len(c) == 2:
        c.append(0.0)
    if len(c) != 3:
        raise TypeError(f"expected a 2D or 3D point/vector, got {p!r}")
    return [float(x) for x in c]


def _add(a, b):
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]


def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _mul(a, s):
    return [a[0] * s, a[1] * s, a[2] * s]


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _mid(a, b):
    return _mul(_add(a, b), 0.5)


def _unit(a):
    n = math.sqrt(_dot(a, a))
    if n == 0.0:
        raise ValueError("degenerate geometry: zero-length frame axis")
    return _mul(a, 1.0 / n)


def _frame(o, x, z) -> dict:
    """Right-handed orthonormal frame from an origin, an x hint and a z direction."""
    z = _unit(z)
    x = _unit(_sub(x, _mul(z, _dot(x, z))))
    return {"o": list(o), "x": x, "y": _cross(z, x), "z": z}


def _in_frame(f, cx, cy, cz=0.0):
    return _add(f["o"], _add(_mul(f["x"], cx), _add(_mul(f["y"], cy), _mul(f["z"], cz))))


# --- evaluators (mirror of protocol/SCENE.md and frontend/src/geom) -------
def eval_curve(g: dict, t: float) -> list[float]:
    kind = g["type"]
    if kind == "line":
        return _add(g["o"], _mul(g["d"], t))
    if kind == "bspline_curve":
        return eval_bspline_curve(g, t)
    f = g["frame"]
    if kind == "circle":
        return _in_frame(f, g["r"] * math.cos(t), g["r"] * math.sin(t))
    if kind == "ellipse":
        return _in_frame(f, g["a"] * math.cos(t), g["b"] * math.sin(t))
    if kind == "parabola":
        return _in_frame(f, t * t / (4.0 * g["f"]), t)
    if kind == "hyperbola":
        return _in_frame(f, g["a"] * math.cosh(t), g["b"] * math.sinh(t))
    raise ValueError(f"not a curve: {kind}")


def eval_surface(g: dict, u: float, v: float) -> list[float]:
    kind = g["type"]
    if kind == "bspline_surface":
        return eval_bspline_surface(g, u, v)
    f = g["frame"]
    if kind == "plane":
        return _in_frame(f, u, v)
    if kind == "cylinder":
        return _in_frame(f, g["r"] * math.cos(u), g["r"] * math.sin(u), v)
    if kind == "cone":
        radius = g["ref_radius"] + v * math.sin(g["semi_angle"])
        return _in_frame(f, radius * math.cos(u), radius * math.sin(u), v * math.cos(g["semi_angle"]))
    if kind == "sphere":
        rc = g["r"] * math.cos(v)
        return _in_frame(f, rc * math.cos(u), rc * math.sin(u), g["r"] * math.sin(v))
    if kind == "torus":
        rho = g["R"] + g["r"] * math.cos(v)
        return _in_frame(f, rho * math.cos(u), rho * math.sin(u), g["r"] * math.sin(v))
    raise ValueError(f"not a surface: {kind}")


def _flat_knots(knots, mults) -> list[float]:
    """The flat knot vector: knot ``i`` repeated ``mults[i]`` times."""
    flat: list[float] = []
    for k, m in zip(knots, mults):
        flat.extend([float(k)] * int(m))
    return flat


def _in_period(u: float, first: float, last: float) -> float:
    if first <= u < last:
        return u
    period = last - first
    return max(first, u + period * math.ceil((first - u) / period))


def _basis_values(degree: int, left: list[float], right: list[float]) -> list[float]:
    """Non-zero Cox–de Boor basis functions (NURBS Book A2.2)."""
    out = [1.0]
    for j in range(1, degree + 1):
        saved = 0.0
        for r in range(j):
            temp = out[r] / (right[r + 1] + left[j - r])
            out[r] = saved + right[r + 1] * temp
            saved = left[j - r] * temp
        out.append(saved)
    return out


def _locate(flat: list[float], degree: int, periodic: bool, poles: int, seam: int, u: float):
    """The span's first pole and non-zero basis functions at ``u`` (mirrors geomcore)."""
    if not periodic:
        lo, hi = degree, len(flat) - 1 - degree
        uc = min(max(u, flat[lo]), flat[hi])
        span, length = lo, hi - lo
        while length > 1:
            half = length // 2
            if flat[span + half] <= uc:
                span += half
            length -= half
        while span > lo and flat[span] >= flat[span + 1]:
            span -= 1
        left = [0.0] + [uc - flat[span + 1 - j] for j in range(1, degree + 1)]
        right = [0.0] + [flat[span + j] - uc for j in range(1, degree + 1)]
        return span - degree, _basis_values(degree, left, right)
    first, last = flat[0], flat[-1]
    period = last - first
    uu = last if u == last else _in_period(u, first, last)
    block = flat[:poles]
    n = len(block)
    local = max(i for i, k in enumerate(block) if k <= uu)
    def knot(i: int) -> float:
        # Python's % and // already floor, matching rem_euclid/div_euclid.
        return block[i % n] + period * (i // n)
    left = [0.0] + [uu - knot(local + 1 - j) for j in range(1, degree + 1)]
    right = [0.0] + [knot(local + j) - uu for j in range(1, degree + 1)]
    return (local + poles + 1 - seam) % poles, _basis_values(degree, left, right)


def _sum_span(pts, weights, periodic: bool, first: int, values) -> list[float]:
    n = len(pts)
    x = y = z = w = 0.0
    for j, basis in enumerate(values):
        index = (first + j) % n if periodic else first + j
        p = pts[index]
        b = basis * weights[index] if weights else basis
        x += b * p[0]
        y += b * p[1]
        z += b * p[2]
        w += b
    return [x / w, y / w, z / w] if weights else [x, y, z]


def eval_bspline_curve(g: dict, t: float) -> list[float]:
    """Point of a ``bspline_curve`` geom at ``t`` (de Boor, as geomcore evaluates it)."""
    flat = _flat_knots(g["knots"], g["multiplicities"])
    first, values = _locate(flat, g["degree"], g["periodic"], len(g["poles"]), g["multiplicities"][0], t)
    return _sum_span(g["poles"], g.get("weights"), g["periodic"], first, values)


def eval_bspline_surface(g: dict, u: float, v: float) -> list[float]:
    """Point of a ``bspline_surface`` geom at ``(u, v)`` (tensor-product de Boor)."""
    u_flat = _flat_knots(g["u_knots"], g["u_multiplicities"])
    v_flat = _flat_knots(g["v_knots"], g["v_multiplicities"])
    first_u, u_values = _locate(u_flat, g["u_degree"], g["u_periodic"], g["nu"], g["u_multiplicities"][0], u)
    first_v, v_values = _locate(v_flat, g["v_degree"], g["v_periodic"], g["nv"], g["v_multiplicities"][0], v)
    nv = g["nv"]
    wraps_v = first_v + g["v_degree"] >= nv
    weights = g.get("weights")
    x = y = z = w = 0.0
    for i, bu in enumerate(u_values):
        iu = (first_u + i) % g["nu"] if g["u_periodic"] else first_u + i
        ax = ay = az = aw = 0.0
        for j, bv in enumerate(v_values):
            iv = (first_v + j) % nv if wraps_v else first_v + j
            index = iu * nv + iv
            p = g["poles"][index]
            b = bv * weights[index] if weights else bv
            ax += b * p[0]
            ay += b * p[1]
            az += b * p[2]
            aw += b
        x += bu * ax
        y += bu * ay
        z += bu * az
        w += bu * aw
    return [x / w, y / w, z / w] if weights else [x, y, z]


def _check(name: str, want: list[float], got: list[float]) -> None:
    err = math.dist(want, got)
    if err > CHECK_TOL * max(1.0, math.hypot(*want)):
        raise ValueError(
            f"{name}: recovered geometry is off by {err:.3g} at the check parameter — "
            "geomcore's parametrization convention may have changed; please report it"
        )


# --- frame recovery ----------------------------------------------------------
def _curve_geom(obj, name: str) -> dict:
    def P(t):
        return as_vec(obj.eval_point(t))

    if name in ("Line3D", "Line2D"):
        return {"type": "line", "o": as_vec(obj.origin()), "d": as_vec(obj.direction())}
    if name in ("Circle3D", "Circle2D"):
        o = as_vec(obj.center())
        x = _sub(P(0.0), o)
        # A (u, v) circle may run clockwise (parametrize_on a circle facing away): its frame's z is then −z.
        z = as_vec(obj.normal()) if name == "Circle3D" else _cross(x, _sub(P(math.pi / 2), o))
        return {"type": "circle", "frame": _frame(o, x, z), "r": float(obj.radius())}
    if name == "Ellipse3D":
        o = as_vec(obj.center())
        x, y = _sub(P(0.0), o), _sub(P(math.pi / 2), o)
        return {"type": "ellipse", "frame": _frame(o, x, _cross(x, y)),
                "a": float(obj.major_radius()), "b": float(obj.minor_radius())}
    if name == "Hyperbola3D":
        o = as_vec(obj.center())
        x, y = _sub(P(0.0), o), _sub(P(1.0), P(-1.0))
        return {"type": "hyperbola", "frame": _frame(o, x, _cross(x, y)),
                "a": float(obj.major_radius()), "b": float(obj.minor_radius())}
    if name == "Parabola3D":
        o, focal = P(0.0), float(obj.focal())
        x = _mul(_sub(_add(P(1.0), P(-1.0)), _mul(o, 2.0)), focal)  # = x/2 whatever the sign of f
        y = _sub(P(1.0), P(-1.0))
        return {"type": "parabola", "frame": _frame(o, x, _cross(x, y)), "f": focal}
    raise TypeError(name)


def _surface_geom(obj, name: str) -> dict:
    def S(u, v):
        return as_vec(obj.eval_point(u, v))

    if name == "Plane":
        o = S(0.0, 0.0)
        x, y = _sub(S(1.0, 0.0), o), _sub(S(0.0, 1.0), o)
        return {"type": "plane", "frame": _frame(o, x, _cross(x, y))}
    if name == "Cylinder":
        a = S(0.0, 0.0)
        o = _mid(a, S(math.pi, 0.0))
        return {"type": "cylinder", "frame": _frame(o, _sub(a, o), _sub(S(0.0, 1.0), a)), "r": float(obj.radius())}
    if name == "Cone":
        phi, r0 = float(obj.semi_angle()), float(obj.ref_radius())
        c0 = _mid(S(0.0, 0.0), S(math.pi, 0.0))
        c1 = _mid(S(0.0, 1.0), S(math.pi, 1.0))
        ring = 0.0 if abs(r0) > 1e-12 else 1.0  # the v = 0 ring is a point when ref_radius = 0
        x = _sub(S(0.0, ring), c0 if ring == 0.0 else c1)
        if r0 + ring * math.sin(phi) < 0.0:
            x = _mul(x, -1.0)  # negative ring radius points the other way
        return {"type": "cone", "frame": _frame(c0, x, _sub(c1, c0)), "semi_angle": phi, "ref_radius": r0}
    if name == "Sphere":
        o = as_vec(obj.center())
        return {"type": "sphere", "frame": _frame(o, _sub(S(0.0, 0.0), o), _sub(S(0.0, math.pi / 2), o)),
                "r": float(obj.radius())}
    if name == "Torus":
        big, small = float(obj.major_radius()), float(obj.minor_radius())
        a = S(0.0, 0.0)
        o = _mid(a, S(math.pi, 0.0))
        x = _unit(_sub(a, o))
        z = _sub(_sub(S(0.0, math.pi / 2), o), _mul(x, big))
        return {"type": "torus", "frame": _frame(o, x, z), "R": big, "r": small}
    raise TypeError(name)


def _call(obj, name: str):
    """``obj.name()`` when it is a method (geomcore's ``basis()``/``first()``/``min()``),
    else the plain attribute (duck-typed stand-ins in tests)."""
    attr = getattr(obj, name)
    return attr() if callable(attr) else attr


def _has(obj, name: str) -> bool:
    return callable(getattr(obj, name, None))


def _has_bspline_curve_getters(obj) -> bool:
    return _has(obj, "poles") and _has(obj, "knots") and _has(obj, "multiplicities")


def _has_bspline_surface_getters(obj) -> bool:
    return _has(obj, "poles") and _has(obj, "u_knots") and _has(obj, "u_multiplicities")


def _bspline_curve_geom(obj, segments: int = _BSPLINE_SEGMENTS) -> dict:
    """A ``BSplineCurve3D`` as its exact definition (degree, poles, weights, knots,
    multiplicities, periodicity); bindings without B-spline getters fall back to a
    sampled polyline over ``bounds()``."""
    if _has_bspline_curve_getters(obj):
        weights = obj.weights()
        geom = {
            "type": "bspline_curve",
            "degree": int(obj.degree()),
            "poles": [as_vec(p) for p in obj.poles()],
            "knots": [float(k) for k in obj.knots()],
            "multiplicities": [int(m) for m in obj.multiplicities()],
            "periodic": bool(obj.is_periodic()) if _has(obj, "is_periodic") else False,
        }
        if weights is not None:
            geom["weights"] = [float(w) for w in weights]
        _check("BSplineCurve3D", as_vec(obj.eval_point(_CHECK_T)), eval_bspline_curve(geom, _CHECK_T))
        return geom
    t0, t1 = obj.bounds()
    return {"type": "polyline", "points": sample_curve(obj.eval_point, t0, t1, segments)}


def _bspline_surface_geom(obj) -> dict:
    """A ``BSplineSurface`` as its exact definition; bindings without B-spline getters
    fall back to a sampled mesh (which needs an explicit ``u=``/``v=`` domain)."""
    if _has_bspline_surface_getters(obj):
        weights = obj.weights()
        rows = obj.poles()
        geom = {
            "type": "bspline_surface",
            "u_degree": int(obj.u_degree()),
            "v_degree": int(obj.v_degree()),
            "nu": int(obj.u_pole_count()),
            "nv": int(obj.v_pole_count()),
            "poles": [as_vec(p) for row in rows for p in row],
            "u_knots": [float(k) for k in obj.u_knots()],
            "u_multiplicities": [int(m) for m in obj.u_multiplicities()],
            "v_knots": [float(k) for k in obj.v_knots()],
            "v_multiplicities": [int(m) for m in obj.v_multiplicities()],
            "u_periodic": bool(obj.is_u_periodic()) if _has(obj, "is_u_periodic") else False,
            "v_periodic": bool(obj.is_v_periodic()) if _has(obj, "is_v_periodic") else False,
        }
        if weights is not None:
            geom["weights"] = [float(w) for row in weights for w in row]
        _check("BSplineSurface", as_vec(obj.eval_point(*_CHECK_UV)), eval_bspline_surface(geom, *_CHECK_UV))
        return geom
    return {}


def _trimmed_geom(obj, segments: int) -> dict:
    """A ``TrimmedCurve3D``/``TrimmedCurve2D`` as protocol geometry: its basis curve
    converted as usual, limited to ``[first, last]`` — an analytic basis keeps its
    exact definition with ``range`` (the viewer clips it in closed form); a B-spline
    basis goes native with ``range`` (or sampled over the trimmed range on bindings
    without B-spline getters)."""
    basis = _call(obj, "basis")
    first, last = float(_call(obj, "first")), float(_call(obj, "last"))
    name = type(basis).__name__
    if name in CURVES:
        geom = _curve_geom(basis, name)
        _check(f"TrimmedCurve({name})", as_vec(basis.eval_point(_CHECK_T)), eval_curve(geom, _CHECK_T))
        return {**geom, "range": [first, last]}
    if name == "BSplineCurve3D":
        if _has_bspline_curve_getters(basis):
            return {**_bspline_curve_geom(basis), "range": [first, last]}
        # No B-spline getters: sample the trimmed range (which may cross the seam).
        return {"type": "polyline", "points": sample_curve(basis.eval_point, first, last, segments)}
    raise TypeError(f"TrimmedCurve of {name}: expected a line, circle, ellipse, parabola, hyperbola or B-spline")


def _box_geom(obj) -> dict:
    """A ``BoundingBox3D`` (geomcore 0.32; duck-typed so older bindings simply never
    produce one) as a ``box``: its ``min()``/``max()`` corners."""
    return {"type": "box", "min": as_vec(_call(obj, "min")), "max": as_vec(_call(obj, "max"))}


def _surface_domain(obj, u, v):
    """A B-spline surface's ``(u, v)`` domain: explicit ``u=``/``v=`` win, else the
    surface's own ``u_bounds()``/``v_bounds()`` when the binding exposes them
    (older geomcore-py has no domain getter, so the caller must pass ``u=``/``v=``)."""
    if u is not None and v is not None:
        return u, v
    bounds = getattr(obj, "u_bounds", None), getattr(obj, "v_bounds", None)
    if callable(bounds[0]) and callable(bounds[1]):
        ub, vb = obj.u_bounds(), obj.v_bounds()
        return (u if u is not None else ub), (v if v is not None else vb)
    return u, v


def _collapsed_curve(obj, name: str) -> list[float] | None:
    """Where a curve that is a single point sits, else None: the radius-zero circle or the
    B-spline with coinciding poles that ``u_iso``/``v_iso`` give at an apex, a pole or a pinch
    (radii on the wire must be positive)."""
    if name == "Circle3D":
        centre = as_vec(obj.center())
        return centre if abs(float(obj.radius())) <= 1e-12 * max(1.0, math.hypot(*centre)) else None
    if name == "BSplineCurve3D" and _has_bspline_curve_getters(obj):
        poles = [as_vec(p) for p in obj.poles()]
        reach = 1e-12 * max(1.0, math.hypot(*poles[0]))
        return poles[0] if all(math.dist(p, poles[0]) <= reach for p in poles) else None
    return None


def _single(obj, label: str | None, u, v, resolution: int | None = None) -> list[dict]:
    segments = resolution if resolution is not None else _BSPLINE_SEGMENTS
    grid = resolution if resolution is not None else _BSPLINE_GRID
    name = type(obj).__name__
    collapsed = _collapsed_curve(obj, name)
    if collapsed is not None:
        geom = {"type": "point", "p": collapsed}
    elif name in POINTS:
        geom = {"type": "point", "p": as_vec(obj)}
    elif name in CURVES:
        geom = _curve_geom(obj, name)
        _check(name, as_vec(obj.eval_point(_CHECK_T)), eval_curve(geom, _CHECK_T))
    elif name in SURFACES:
        geom = _surface_geom(obj, name)
        _check(name, as_vec(obj.eval_point(*_CHECK_UV)), eval_surface(geom, *_CHECK_UV))
    elif name in TRIMMED:
        geom = _trimmed_geom(obj, segments)
    elif name in BOXES:
        geom = _box_geom(obj)
    elif name == "BSplineCurve3D":
        geom = _bspline_curve_geom(obj, segments)
    elif name == "BSplineSurface":
        geom = _bspline_surface_geom(obj)
        if not geom:
            u, v = _surface_domain(obj, u, v)
            if u is None or v is None:
                raise TypeError("this geomcore-py has no BSplineSurface domain getter: pass u=(u0, u1) and v=(v0, v1)")
            vertices, indices = sample_surface_grid(obj.eval_point, u[0], u[1], v[0], v[1], grid, grid)
            geom = {"type": "mesh", "vertices": vertices, "indices": indices}
    else:
        raise TypeError(name)
    return [{"label": label, "geom": geom, "source": name}]


UV_CURVES = frozenset({"Line2D", "Circle2D", "TrimmedCurve2D"})


def uv_curve(curve) -> dict:
    """A pcurve's curve as protocol geometry in z = 0 (x is u, y is v): a geomcore ``Line2D`` or
    ``Circle2D`` (what ``curve.parametrize_on(surface)`` returns), a ``TrimmedCurve2D`` of one
    of those (kept exact, with ``range``), or a sequence of ``(u, v)`` pairs, which becomes
    a polyline."""
    name = type(curve).__name__
    if name in UV_CURVES:
        [part] = _single(curve, None, None, None)
        geom = part["geom"]
        if geom["type"] not in ("line", "circle"):
            raise TypeError(f"a pcurve takes a Line2D, a Circle2D, a TrimmedCurve2D of those, or (u, v) pairs, not {name} of {geom['type']}")
        return geom
    if name in GEOMETRY:
        raise TypeError(f"a pcurve takes a Line2D, a Circle2D, a TrimmedCurve2D of those, or (u, v) pairs, not a {name}")
    points = [as_vec(p) for p in curve]
    if any(p[2] != 0.0 for p in points):
        raise TypeError("a pcurve's points are (u, v) pairs")
    if len(points) < 2:
        raise TypeError("a pcurve polyline needs at least 2 (u, v) points")
    return {"type": "polyline", "points": points}


# --- results and containers --------------------------------------------------
_NOT_NUMERIC = object()


def _numeric(x):
    """A parameter as JSON: a number (None when not finite), a tuple as a list; ``_NOT_NUMERIC`` otherwise."""
    if isinstance(x, bool):
        return _NOT_NUMERIC
    if isinstance(x, int):
        return x
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, (list, tuple)):
        items = [_numeric(i) for i in x]
        return _NOT_NUMERIC if any(i is _NOT_NUMERIC for i in items) else items
    return _NOT_NUMERIC


def _hit(item):
    """``(geometry, params)`` for a hit tuple such as ``(t, P, s)``: exactly one geometry and
    at least one number (or tuple of numbers); None for anything else."""
    if not isinstance(item, tuple):
        return None
    geoms = [x for x in item if type(x).__name__ in GEOMETRY]
    if len(geoms) != 1 or len(item) < 2:
        return None
    params = [_numeric(x) for x in item if x is not geoms[0]]
    if any(p is _NOT_NUMERIC for p in params):
        return None
    return geoms[0], params


def _leaves(payload) -> list[tuple]:
    """``(geometry, params)`` for every geometry inside a result payload; ``params`` are the
    numbers of its hit tuple (``(t, P, s)`` → ``[t, s]``), None for a bare geometry."""
    if payload is None:
        return []
    if type(payload).__name__ in GEOMETRY:
        return [(payload, None)]
    hit = _hit(payload)
    if hit is not None:
        return [hit]
    if isinstance(payload, (list, tuple)):
        return [leaf for item in payload for leaf in _leaves(item)]
    return []


def _labelled(items: list, label: str | None, u, v, tag: str | None = None, resolution: int | None = None) -> list[dict]:
    """One part per ``(geometry, params)``, labelled ``P₁``, ``P₂`` … when there are several;
    the result tag and the hit parameters go to ``meta`` (spec §3.3)."""
    parts: list[dict] = []
    for i, (item, params) in enumerate(items, start=1):
        name = label if len(items) == 1 or not label else indexed(label, i)
        [part] = _single(item, name, u, v, resolution)
        meta: dict = {}
        if tag is not None:
            meta["tag"] = tag
        if params is not None:
            meta["params"] = params
        if meta:
            part["meta"] = meta
        parts.append(part)
    return parts


def _note(text: str, label: str | None, level: str = "info", kind: str = "note") -> dict:
    return {
        "label": None,
        "key": f"{label}·{kind}" if label else None,
        "geom": {"type": "note", "text": f"{label}: {text}" if label else text, "level": level},
    }


def _is_result(obj) -> bool:
    return isinstance(obj, tuple) and len(obj) == 2 and isinstance(obj[0], str)


def _result(tag: str, payload, label: str | None, u, v, resolution: int | None = None) -> list[dict]:
    if tag in EMPTY_NOTES:
        return [_note(EMPTY_NOTES[tag], label)]
    if tag == "not_analytic":
        return [_note("no closed form — try geomcore.intersect_marching", label, "warn")]
    leaves = _leaves(payload)
    parts = _labelled(leaves, label, u, v, tag, resolution)
    if tag in INFO_NOTES:
        parts.append(_note(INFO_NOTES[tag], label))
    known = tag in INFO_NOTES or tag in POINT_TAGS or tag in CURVE_TAGS
    if not known:
        parts.append(_note(f"unrecognized result tag {tag!r}", label, "warn"))
    elif not leaves:
        # Last, so it wins over the info note when both share the same key.
        parts.append(_note(f"result {tag!r} has no drawable geometry", label, "warn"))
    return parts


# --- projection results (geomcore >= 0.36) ------------------------------------
CURVE_PROJECTIONS = frozenset({"CurveProjection", "CurveProjection2D"})
PROJECTIONS = CURVE_PROJECTIONS | {"SurfaceProjection"}


def _surface_window_bounds(name: str, result, u, v) -> tuple[tuple | None, tuple | None, float]:
    """Parameter bounds around the closest point for the directions that need them, and the
    half-size used for them. Sampled surfaces need both directions; analytic ones only the
    infinite ones (``with_window`` fills the periodic ones with a full period)."""
    half = max(_WINDOW_MIN_HALF_SIZE, _WINDOW_DISTANCE_FACTOR * float(result.distance))
    bounds_u = u if u is not None else (result.u - half, result.u + half)
    bounds_v = v if v is not None else (result.v - half, result.v + half)
    if name == "BSplineSurface":
        return bounds_u, bounds_v, half
    infinite = _INFINITE.get(name.lower(), ())
    return (bounds_u if "u" in infinite or u is not None else None), (
        bounds_v if "v" in infinite or v is not None else None), half


def _projection(result, label: str | None, u=None, v=None, resolution: int | None = None) -> list[dict]:
    """The target, the query point, the closest point and a dashed segment between them, in one group.

    The recipe styles (accent colour, dashed connector) are defaults: ``color=`` or ``dashed=``
    given to ``add`` override them. A surface target is windowed around the closest point unless
    ``u=`` / ``v=`` say otherwise.
    """
    if label is None:
        label = f"projection on {type(result.target).__name__}"
    if type(result).__name__ == "SurfaceProjection":
        name = type(result.target).__name__
        bounds_u, bounds_v, half = _surface_window_bounds(name, result, u, v)
        [target] = _single(result.target, None, bounds_u, bounds_v, resolution)
        if name in _INFINITE or name.lower() in _INFINITE:
            target["geom"] = with_window(target["geom"], half, bounds_u, bounds_v)
        params = [result.u, result.v]
    else:
        [target] = _single(result.target, None, None, None, resolution)
        params = [result.parameter]
    query, closest = as_vec(result.query_point), as_vec(result.point)
    closest_meta = {"tag": "projection", "params": _numeric(params)}
    accent = {"color": ACCENT}
    neutral = {"color": QUERY_POINT_COLOR}
    return [
        {**target, "key": f"{label}·target", "group": label},
        {"label": "query point", "key": f"{label}·query", "group": label, "style": neutral,
         "geom": {"type": "point", "p": query}},
        {"label": f"closest point, d = {float(result.distance):.6g}", "key": f"{label}·closest", "group": label,
         "style": accent, "meta": closest_meta, "geom": {"type": "point", "p": closest}},
        {"label": None, "key": f"{label}·distance", "group": label, "style": {**accent, "dashed": True},
         "geom": {"type": "polyline", "points": [query, closest]}},
    ]


# --- intersection and extrema results (geomcore >= 0.36) ----------------------
INTERSECTIONS = frozenset({
    "CurveCurveIntersection", "CurveCurveIntersection2D", "CurveSurfaceIntersection", "SurfaceSurfaceIntersection",
})
TRIMMED_CURVES = frozenset({"TrimmedCurve3D", "TrimmedCurve2D"})
OPERAND_OPACITY = 0.45
_RANGE_SEGMENTS = 64
# Twelve box segments as one polyline over the corner indices (bit 0 is x, bit 1 is y, bit 2 is z);
# two segments are walked twice.
_BOX_PATH = (0, 1, 3, 2, 0, 4, 5, 1, 3, 7, 6, 2, 6, 4, 6, 7, 5)


_WINDOW_DEFAULT_HALF_SIZE = 5.0
_WINDOW_SPAN_FACTOR = 0.75
_REFERENCE_POINT_LIMIT = 24
_SAMPLES_AROUND = 8


def _geometry_reference_points(geom: dict) -> list[list[float]]:
    """A few points on a protocol geometry (None-free, finite), to size windows around."""
    kind = geom["type"]
    if kind == "point":
        return [geom["p"]]
    if kind == "polyline":
        return list(geom["points"])
    if kind == "mesh":
        return list(geom["vertices"])
    if kind == "line":
        return [geom["o"]]
    if kind in ("circle", "ellipse"):
        return [eval_curve(geom, TAU * i / _SAMPLES_AROUND) for i in range(_SAMPLES_AROUND)]
    if kind in ("parabola", "hyperbola"):
        return [eval_curve(geom, 0.0)]
    if kind in ("sphere", "torus"):
        low, high = _FULL_PERIOD[kind]["v"]
        return [eval_surface(geom, TAU * i / _SAMPLES_AROUND, low + (high - low) * j / 4)
                for i in range(_SAMPLES_AROUND) for j in range(5)]
    return []


def _operand_window(operand, reference_points, user_u, user_v) -> tuple[tuple | None, tuple | None]:
    """Parameter bounds, for the unbounded directions of a surface operand, around the result.

    Each reference point is projected onto the operand; a direction spans the projections plus a margin,
    or a fixed half-size when there is nothing to project. Independent of anything else in the scene.
    A user's ``u`` / ``v`` wins.
    """
    kind = type(operand).__name__.lower()
    point_class = type(operand.eval_point(0.0, 0.0))
    step = max(1, math.ceil(len(reference_points) / _REFERENCE_POINT_LIMIT))
    projections = [operand.project_point(point_class(*p)) for p in reference_points[::step]]
    bounds = {}
    for direction, user in (("u", user_u), ("v", user_v)):
        if user is not None:
            bounds[direction] = user
        elif direction in _INFINITE[kind]:
            values = [getattr(projection, direction) for projection in projections]
            low, high = (min(values), max(values)) if values else (0.0, 0.0)
            half = _WINDOW_SPAN_FACTOR * (high - low) if high > low else _WINDOW_DEFAULT_HALF_SIZE
            bounds[direction] = ((low + high) / 2 - half, (low + high) / 2 + half)
        else:
            bounds[direction] = None
    return bounds["u"], bounds["v"]


def _operands(result, label: str, reference_points: list, u, v, resolution: int | None = None) -> list[dict]:
    """Both intersected shapes, translucent so the result stays visible inside them. Unbounded
    surfaces are windowed around the result and the bounded operand."""
    operands = (result.first, result.second)
    parts = []
    for name, obj in zip(("first", "second"), operands):
        [part] = _single(obj, None, u, v, resolution)
        parts.append({**part, "key": f"{label}·{name}", "group": label, "style": {"opacity": OPERAND_OPACITY}})
    points = list(reference_points)
    for part in parts:
        if not _INFINITE.get(part["geom"]["type"]):
            points += _geometry_reference_points(part["geom"])
    for obj, part in zip(operands, parts):
        if _INFINITE.get(part["geom"]["type"]) and "window" not in part["geom"]:
            bounds_u, bounds_v = _operand_window(obj, points, u, v)
            part["geom"] = with_window(part["geom"], _WINDOW_DEFAULT_HALF_SIZE, bounds_u, bounds_v)
    return parts


def _sampled_range(curve, first: float, last: float) -> dict:
    points = [as_vec(curve.eval_point(first + (last - first) * i / _RANGE_SEGMENTS))
              for i in range(_RANGE_SEGMENTS + 1)]
    return {"label": None, "geom": {"type": "polyline", "points": points}}


def _curve_operand(result):
    """The curve of a curve-surface result, whichever side the receiver was: the ``curve`` property
    when geomcore provides it, else the operand that is not a surface."""
    curve = getattr(result, "curve", None)
    if curve is not None:
        return curve
    first_is_surface = type(result.first).__name__ in SURFACES | {"BSplineSurface"}
    return result.second if first_is_surface else result.first


def _overlap_part(result, overlap, key: str, label: str) -> dict:
    """The operand over the overlap's parameter range: a curve-curve overlap carries one range per
    operand (the first operand's when it is bounded, else the second's); a curve in a surface is a
    plain ``(first, last)`` range of the curve. Unbounded everywhere draws the whole first operand."""
    if isinstance(overlap, (tuple, list)):
        candidates = ((_curve_operand(result), tuple(overlap)),)
    else:
        candidates = ((result.first, overlap.first_range), (result.second, overlap.second_range))
    for operand, bounds in candidates:
        if all(math.isfinite(b) for b in bounds):
            part = _sampled_range(operand, *bounds)
            break
    else:
        [part] = _single(_curve_operand(result) if isinstance(overlap, (tuple, list)) else result.first, None, None, None)
    return {**part, "key": key, "group": label, "style": {"color": ACCENT}, "keeps_style": ("opacity",)}


def _box_part(region, key: str, label: str) -> dict | None:
    low, high = as_vec(region.min_corner), as_vec(region.max_corner)
    if not all(math.isfinite(c) for c in (*low, *high)):
        return None
    corners = [[(high if index >> axis & 1 else low)[axis] for axis in range(3)] for index in range(8)]
    return {"label": None, "key": key, "group": label, "style": {"color": ACCENT, "dashed": True}, "keeps_style": ("opacity",),
            "geom": {"type": "polyline", "points": [corners[i] for i in _BOX_PATH]}}


def _param(value):
    return None if value is None else _numeric(value)


def _hit_params(hit) -> list:
    if hasattr(hit, "curve_parameter"):
        return [_param(hit.curve_parameter), _param(hit.surface_parameters)]
    return [_param(hit.first_parameter), _param(hit.second_parameter)]


def _result_point(point, key: str, label: str, text: str | None, meta: dict | None = None) -> dict:
    part = {"label": text, "key": key, "group": label, "style": {"color": ACCENT}, "keeps_style": ("opacity",),
            "geom": {"type": "point", "p": as_vec(point)}}
    if meta:
        part["meta"] = meta
    return part


def _reason_text(reason) -> str:
    if reason is None:
        return ""
    return ": " + str(getattr(reason, "name", reason)).lower().replace("_", " ")


def _completeness_parts(result, label: str) -> list[dict]:
    completeness = result.completeness
    status = completeness.status.name
    if status == "INCOMPLETE":
        reason = _reason_text(completeness.reason)
        parts = [_note(f"incomplete, some intersections may be missing{reason}", label, "warn", "status")]
        boxes = (_box_part(region, f"{label}·region{i}", label) for i, region in enumerate(completeness.regions, 1))
        return parts + [box for box in boxes if box is not None]
    if status == "SAMPLED":
        return [_note("sampled, so a very small intersection could be missed", label, "info", "status")]
    return []


def _intersection(result, label: str | None, u=None, v=None, resolution: int | None = None) -> list[dict]:
    """Both operands translucent, the result in the accent colour, and notes on the method and completeness.

    One group per result, named after the operands unless ``label`` is given. Recipe styles are
    defaults: ``color=`` or ``dashed=`` given to ``add`` override them; ``opacity=`` applies to the
    operands only.
    """
    first_name, second_name = type(result.first).__name__, type(result.second).__name__
    label = label or f"{first_name} × {second_name}"
    parts = []
    for i, piece in enumerate(getattr(result, "curves", ()), start=1):
        [curve] = _single(piece.curve, None, None, None, resolution)
        parts.append({**curve, "key": f"{label}·curve{i}", "group": label, "style": {"color": ACCENT},
                      "keeps_style": ("opacity",), "label": "tangent" if piece.tangent else None})
    for i, hit in enumerate(getattr(result, "hits", ()), start=1):
        text = "tangent" if hit.multiplicity >= 2 else None
        parts.append(_result_point(hit.point, f"{label}·hit{i}", label, text,
                                   {"tag": "hit", "params": _hit_params(hit)}))
    for i, point in enumerate(getattr(result, "contact_points", ()), start=1):
        parts.append(_result_point(point, f"{label}·contact{i}", label, "tangent"))
    for i, overlap in enumerate(getattr(result, "overlaps", ()), start=1):
        parts.append(_overlap_part(result, overlap, f"{label}·overlap{i}", label))
    status_parts = _completeness_parts(result, label)
    parts += [p for p in status_parts if p["geom"]["type"] != "note"]
    reference_points = [point for p in parts for point in _geometry_reference_points(p["geom"])]
    notes = [p for p in status_parts if p["geom"]["type"] == "note"]
    if not result:
        notes.insert(0, _note(EMPTY_NOTES["empty"], label))
    if hasattr(result, "is_coincident") and result.is_coincident():
        notes.insert(0, _note(INFO_NOTES["coincident"], label, "info", "coincident"))
    notes.insert(0, _note(f"method: {result.method.name.lower()}", label, "info", "method"))
    return _operands(result, label, reference_points, u, v, resolution) + parts + notes


def _extrema(result, label: str | None, u=None, v=None, resolution: int | None = None) -> list[dict]:
    """Both curves translucent and a dashed segment joining the two points of each minimum."""
    first_name, second_name = type(result.first).__name__, type(result.second).__name__
    label = label or f"{first_name} × {second_name} extrema"
    parts = []
    for i, minimum in enumerate(result.minima, start=1):
        ends = [as_vec(result.first.eval_point(minimum.first_parameter)),
                as_vec(result.second.eval_point(minimum.second_parameter))]
        parts.append({"label": f"d = {float(minimum.distance):.6g}", "key": f"{label}·minimum{i}", "group": label,
                      "style": {"color": ACCENT, "dashed": True}, "keeps_style": ("opacity",),
                      "meta": {"tag": "extremum", "params": [_param(minimum.first_parameter),
                                                             _param(minimum.second_parameter)]},
                      "geom": {"type": "polyline", "points": ends}})
    if not result.minima:
        parts.append(_note(EMPTY_NOTES["empty"], label))
    reference_points = [point for p in parts for point in _geometry_reference_points(p["geom"])]
    return _operands(result, label, reference_points, u, v, resolution) + parts


_RESULT_OBJECTS = {
    **{name: _projection for name in PROJECTIONS},
    **{name: _intersection for name in INTERSECTIONS},
    "CurveCurveExtrema": _extrema,
}


def _result_object(obj, label: str | None, u=None, v=None, resolution: int | None = None) -> list[dict] | None:
    """Parts for a geomcore result object, dispatched on its class name; None for anything else."""
    recipe = _RESULT_OBJECTS.get(type(obj).__name__)
    return None if recipe is None else recipe(obj, label, u, v, resolution)


def to_objects(obj, label: str | None = None, *, u=None, v=None, resolution: int | None = None) -> list[dict]:
    """Protocol parts for one ``add`` argument: a geomcore object, a result object such as a
    projection, a ``(tag, payload)`` intersection result, or a list/tuple of those. ``resolution``
    sets the sampled fallback density (curve segments, surface grid N×N); exact geometry ignores it."""
    if resolution is not None and (isinstance(resolution, bool) or not isinstance(resolution, int) or resolution < 1):
        raise TypeError(f"resolution must be a positive int, got {resolution!r}")
    parts = _result_object(obj, label, u, v, resolution)
    if parts is not None:
        return parts
    if _is_result(obj):
        return _result(obj[0], obj[1], label, u, v, resolution)
    if type(obj).__name__ in GEOMETRY:
        return _single(obj, label, u, v, resolution)
    if isinstance(obj, (list, tuple)):
        if not obj:
            return [_note(EMPTY_NOTES["empty"], label)]
        leaves = _leaves(obj)
        if not leaves:
            raise TypeError(f"no geometry found in {type(obj).__name__} of length {len(obj)}")
        return _labelled(leaves, label, u, v, None, resolution)
    raise TypeError(
        f"cannot show {type(obj).__name__}: expected a geomcore curve, surface or point, "
        "an intersection result (tag, payload), or a list of those"
    )


# --- surface windows -----------------------------------------------------------
def scene_extent(geoms: Iterable[dict]) -> float:
    """Half-size for infinite surface windows: 1.5 × the farthest finite feature
    from the origin, or 5 for an empty scene."""
    reach = 0.0
    for g in geoms:
        kind = g["type"]
        if kind == "point":
            reach = max(reach, math.hypot(*g["p"]))
        elif kind in ("circle", "sphere"):
            reach = max(reach, math.hypot(*g["frame"]["o"]) + g["r"])
        elif kind == "ellipse":
            reach = max(reach, math.hypot(*g["frame"]["o"]) + g["a"])
        elif kind == "torus":
            reach = max(reach, math.hypot(*g["frame"]["o"]) + g["R"] + g["r"])
        elif kind == "polyline":
            reach = max([reach, *(math.hypot(*p) for p in g["points"])])
        elif kind == "bspline_curve":
            reach = max([reach, *(math.hypot(*p) for p in g["poles"])])
        elif kind == "bspline_surface":
            reach = max([reach, *(math.hypot(*p) for p in g["poles"])])
        elif kind == "box":
            reach = max([reach, math.hypot(*g["min"]), math.hypot(*g["max"])])
        elif kind == "mesh":
            reach = max([reach, *(math.hypot(*p) for p in g["vertices"])])
    return 1.5 * reach if reach > 0.0 else 5.0


def with_window(geom: dict, extent: float, u=None, v=None) -> dict:
    """A surface geom with ``window`` filled: explicit u/v, else full periods, else ±extent.
    A ``bspline_surface`` draws its knot domain unless an explicit ``u=``/``v=`` narrows it."""
    kind = geom["type"]
    if kind == "bspline_surface":
        if u is None and v is None:
            return geom
        window = dict(geom.get("window", {}))
        if u is not None:
            window["u"] = [float(u[0]), float(u[1])]
        if v is not None:
            window["v"] = [float(v[0]), float(v[1])]
        return {**geom, "window": window}
    if kind not in _INFINITE:
        return geom
    window = {d: list(r) for d, r in _FULL_PERIOD[kind].items()}
    for d in _INFINITE[kind]:
        window[d] = [-float(extent), float(extent)]
    if u is not None:
        window["u"] = [float(u[0]), float(u[1])]
    if v is not None:
        window["v"] = [float(v[0]), float(v[1])]
    return {**geom, "window": window}
