import math

import pytest

from geomcore_viewer.adapt import (
    ACCENT,
    PALETTE,
    TAU,
    _frame,
    as_vec,
    eval_curve,
    eval_surface,
    indexed,
    scene_extent,
    subscript,
    to_objects,
    uv_curve,
    with_window,
)

TILTED = _frame([1.0, 2.0, 3.0], [1.0, -1.0, 0.0], [1.0, 1.0, 1.0])


# --- duck-typed stand-ins named like geomcore classes ---------------------
class Point3D:
    def __init__(self, x, y, z=0.0):
        self.x, self.y, self.z = x, y, z


class Vector3D:
    def __init__(self, *c):
        self._c = c

    def components(self):
        return self._c


def fake(name, geom, **getters):
    """An object named ``name`` that evaluates ``geom`` and exposes ``getters``."""

    def eval_point(self, *args):
        p = eval_curve(geom, *args) if len(args) == 1 else eval_surface(geom, *args)
        return Point3D(*p)

    attrs = {"eval_point": eval_point}
    for key, value in getters.items():
        attrs[key] = (lambda value: lambda self: value)(value)
    return type(name, (), attrs)()


def world_z(vector_class):
    """The +z unit vector: geomcore 0.36 renamed ``Vector3D.z()`` to ``unit_z()``."""
    return vector_class.unit_z() if hasattr(vector_class, "unit_z") else vector_class.z()


def assert_frame(got, want):
    for axis in ("o", "x", "y", "z"):
        assert got[axis] == pytest.approx(want[axis], abs=1e-12), axis


CASES = [
    ("Circle3D", {"type": "circle", "frame": TILTED, "r": 1.5},
     {"center": Point3D(*TILTED["o"]), "radius": 1.5, "normal": Vector3D(*TILTED["z"])}),
    ("Ellipse3D", {"type": "ellipse", "frame": TILTED, "a": 3.0, "b": 2.0},
     {"center": Point3D(*TILTED["o"]), "major_radius": 3.0, "minor_radius": 2.0}),
    ("Hyperbola3D", {"type": "hyperbola", "frame": TILTED, "a": 2.0, "b": 1.0},
     {"center": Point3D(*TILTED["o"]), "major_radius": 2.0, "minor_radius": 1.0}),
    ("Parabola3D", {"type": "parabola", "frame": TILTED, "f": 0.7}, {"focal": 0.7}),
    ("Plane", {"type": "plane", "frame": TILTED}, {}),
    ("Cylinder", {"type": "cylinder", "frame": TILTED, "r": 2.0}, {"radius": 2.0}),
    ("Cone", {"type": "cone", "frame": TILTED, "semi_angle": 0.4, "ref_radius": 2.0},
     {"semi_angle": 0.4, "ref_radius": 2.0}),
    ("Cone", {"type": "cone", "frame": TILTED, "semi_angle": 0.4, "ref_radius": 0.0},
     {"semi_angle": 0.4, "ref_radius": 0.0}),
    ("Cone", {"type": "cone", "frame": TILTED, "semi_angle": -0.4, "ref_radius": 0.0},
     {"semi_angle": -0.4, "ref_radius": 0.0}),
    ("Sphere", {"type": "sphere", "frame": TILTED, "r": 3.0}, {"center": Point3D(*TILTED["o"]), "radius": 3.0}),
    ("Torus", {"type": "torus", "frame": TILTED, "R": 4.0, "r": 1.0}, {"major_radius": 4.0, "minor_radius": 1.0}),
]


@pytest.mark.parametrize("name,geom,getters", CASES, ids=[f"{c[0]}-{i}" for i, c in enumerate(CASES)])
def test_recovers_tilted_frames(name, geom, getters):
    [part] = to_objects(fake(name, geom, **getters), "S")
    assert part["label"] == "S" and part["source"] == name
    got = part["geom"]
    assert got["type"] == geom["type"]
    assert_frame(got["frame"], geom["frame"])
    for key in set(geom) - {"type", "frame"}:
        assert got[key] == pytest.approx(geom[key])


def test_line_and_point():
    line = type("Line3D", (), {
        "origin": lambda self: Point3D(1, 2, 3),
        "direction": lambda self: Vector3D(0.0, 0.0, 1.0),
        "eval_point": lambda self, t: Point3D(1, 2, 3 + t),
    })()
    assert to_objects(line)[0]["geom"] == {"type": "line", "o": [1.0, 2.0, 3.0], "d": [0.0, 0.0, 1.0]}
    assert to_objects(Point3D(1, 2, 3), "A") == [{"label": "A", "geom": {"type": "point", "p": [1.0, 2.0, 3.0]}, "source": "Point3D"}]


def test_convention_mismatch_raises():
    geom = {"type": "ellipse", "frame": TILTED, "a": 3.0, "b": 2.0}
    lying = fake("Ellipse3D", geom, center=Point3D(*TILTED["o"]), major_radius=3.0, minor_radius=2.5)
    with pytest.raises(ValueError, match="convention"):
        to_objects(lying)


def test_points_result_gets_subscripted_labels():
    parts = to_objects(("points", [(0.1, Point3D(1, 0, 0), 0.2), (0.3, Point3D(0, 1, 0), 0.4)]), "P")
    assert [p["label"] for p in parts] == ["P₁", "P₂"]
    assert [p["geom"]["p"] for p in parts] == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]


@pytest.mark.parametrize("tag,text", [("empty", "P: ∅"), ("parallel", "P: ∅ (parallel)"), ("skew", "P: ∅ (skew)")])
def test_empty_results_become_notes(tag, text):
    assert to_objects((tag, None), "P") == [
        {"label": None, "key": "P·note", "geom": {"type": "note", "text": text, "level": "info"}}
    ]


def test_not_analytic_and_unknown_tags_warn():
    [note] = to_objects(("not_analytic", None), "X")
    assert note["geom"]["level"] == "warn" and "intersect_marching" in note["geom"]["text"]
    parts = to_objects(("bogus", Point3D(0, 0, 0)), "Y")
    assert parts[0]["geom"]["type"] == "point"
    assert parts[1]["geom"] == {"type": "note", "text": "Y: unrecognized result tag 'bogus'", "level": "warn"}


@pytest.mark.parametrize("tag", ["circle", "tangent"])
def test_known_tag_without_geometry_warns(tag):
    notes = [p["geom"] for p in to_objects((tag, None), "X")]
    warns = [g for g in notes if g["level"] == "warn"]
    assert len(warns) == 1
    assert warns[0]["text"] == f"X: result '{tag}' has no drawable geometry"


def test_points_tag_with_only_scalars_warns():
    [note] = to_objects(("points", [1.0, 2.0]), "X")
    assert note["geom"]["level"] == "warn" and "no drawable geometry" in note["geom"]["text"]


def test_tangent_result_draws_payload_and_notes_it():
    parts = to_objects(("tangent", (2.3, Point3D(1, 1, 0), -1.0)), "T")
    assert parts[0]["geom"] == {"type": "point", "p": [1.0, 1.0, 0.0]}
    assert parts[1]["geom"]["text"] == "T: tangent"


def test_lists():
    assert to_objects([], "Z")[0]["geom"]["text"] == "Z: ∅"
    assert len(to_objects([Point3D(0, 0, 0), Point3D(1, 0, 0)], "Q")) == 2
    with pytest.raises(TypeError, match="no geometry"):
        to_objects([1.0, 2.0])
    with pytest.raises(TypeError, match="object"):
        to_objects(object())


def test_bspline_surface_needs_window():
    surf = type("BSplineSurface", (), {"eval_point": lambda self, u, v: Point3D(u, v, 0.0)})()
    with pytest.raises(TypeError, match="u=.*v="):
        to_objects(surf)
    [part] = to_objects(surf, u=(0, 1), v=(0, 1))
    assert part["geom"]["type"] == "mesh"


def test_windows_and_extent():
    geoms = [{"type": "point", "p": [2.0, 0.0, 0.0]}, {"type": "circle", "frame": TILTED, "r": 1.0}]
    extent = scene_extent(geoms)
    assert extent == pytest.approx(1.5 * (math.sqrt(14) + 1.0))
    assert scene_extent([]) == 5.0
    plane = with_window({"type": "plane", "frame": TILTED}, 3.0)
    assert plane["window"] == {"u": [-3.0, 3.0], "v": [-3.0, 3.0]}
    cyl = with_window({"type": "cylinder", "frame": TILTED, "r": 1.0}, 3.0, v=(0, 2))
    assert cyl["window"] == {"u": [0.0, 2 * math.pi], "v": [0.0, 2.0]}
    point = {"type": "point", "p": [0, 0, 0]}
    assert with_window(point, 3.0) is point


def test_helpers():
    assert subscript(12) == "₁₂"
    assert as_vec((1, 2)) == [1.0, 2.0, 0.0]
    assert as_vec(Vector3D(1, 2, 3)) == [1.0, 2.0, 3.0]


# --- real geomcore (skipped when it is not importable) --------------------
def test_real_geomcore_types_round_trip():
    gc = pytest.importorskip("geomcore")
    from geomcore import Frame3D, Point2D, Point3D as P, Vector2D, Vector3D as V
    from geomcore.curves import Circle2D, Circle3D, Ellipse3D, Hyperbola3D, Line2D, Line3D, Parabola3D
    from geomcore.surfaces import Cone, Cylinder, Plane, Sphere, Torus

    tilted = Frame3D(P(1, 2, 3), V(1, 1, 1), V(1, -1, 0))
    curves = [
        Line3D(P(1, 2, 3), V(1, 1, 0)), Circle3D(P(2, 1, 0), V(0, 1, 1), 1.5),
        Ellipse3D.from_frame(tilted, 3.0, 2.0), Hyperbola3D.from_frame(tilted, 2.0, 1.0),
        Parabola3D.from_frame(tilted, 0.7), Line2D(Point2D(0, 1), Vector2D(1, 1)), Circle2D(Point2D(1, 1), 2.0),
    ]
    for curve in curves:
        [part] = to_objects(curve)
        for t in (-1.3, 0.0, 1.1, 2.5):
            assert eval_curve(part["geom"], t) == pytest.approx(as_vec(curve.eval_point(t)), abs=1e-9), type(curve).__name__
    surfaces = [
        Plane.from_frame(tilted), Cylinder.from_frame(tilted, 2.0), Cone.from_frame(tilted, 0.4, 2.0),
        Cone.from_frame(tilted, 0.4, 0.0),
        Sphere(P(1, 2, 3), 3.0), Torus(P(1, 2, 3), V(1, 1, 1), 4.0, 1.0),
    ]
    for surface in surfaces:
        [part] = to_objects(surface)
        for u, v in ((0.0, 0.0), (1.1, -0.4), (2.5, 0.9)):
            assert eval_surface(part["geom"], u, v) == pytest.approx(as_vec(surface.eval_point(u, v)), abs=1e-9), type(surface).__name__
    assert gc is not None


def test_real_geomcore_intersections():
    pytest.importorskip("geomcore")
    from geomcore import Frame3D, Point3D as P, Vector3D as V
    from geomcore.curves import Circle3D, Ellipse3D

    E = Ellipse3D.from_frame(Frame3D.world(), 3.0, 2.0)
    C = Circle3D(P(2, 1, 0), world_z(V), 1.5)
    far = Circle3D(P(9, 0, 0), world_z(V), 1.0)
    if hasattr(C, "intersect_ellipse"):  # geomcore <= 0.35: (tag, payload) results
        parts = to_objects(C.intersect_ellipse(E), "P")
        assert [p["label"] for p in parts] == ["P₁", "P₂"]
        assert to_objects(C.intersect_circle(far), "Q")[0]["geom"]["text"] == "Q: ∅"
    else:  # geomcore >= 0.36: result objects
        keys = [p["key"] for p in to_objects(C.intersect(E), "P")]
        assert [k for k in keys if "·hit" in k] == ["P·hit1", "P·hit2"]
        assert by_key(to_objects(C.intersect(far), "Q"))["Q·note"]["geom"]["text"] == "Q: ∅"


def test_hit_parameters_and_tag_go_to_meta():
    parts = to_objects(("points", [(0.1, Point3D(1, 0, 0), 0.2), (0.3, Point3D(0, 1, 0))]), "P")
    assert [p["meta"] for p in parts] == [
        {"tag": "points", "params": [0.1, 0.2]},
        {"tag": "points", "params": [0.3]},
    ]


def test_a_bare_geometry_has_no_params():
    [part] = to_objects(("point", Point3D(1, 2, 0)), "A")
    assert part["meta"] == {"tag": "point"}
    assert "meta" not in to_objects(Point3D(1, 2, 0), "B")[0]
    assert "meta" not in to_objects([Point3D(1, 2, 0), Point3D(3, 4, 0)], "C")[0]


def test_hit_parameters_are_json_safe():
    [part] = to_objects(("tangent", (float("nan"), Point3D(1, 1, 0), (1, 2.5))), "T")[:1]
    assert part["meta"] == {"tag": "tangent", "params": [None, [1, 2.5]]}


def test_tuples_that_are_not_hits_still_give_their_geometry():
    two = to_objects(("points", (Point3D(0, 0, 0), Point3D(1, 1, 0))), "P")  # two geometries: not one hit
    assert [p["label"] for p in two] == ["P₁", "P₂"]
    assert all(p["meta"] == {"tag": "points"} for p in two)
    flagged = to_objects(("points", [(True, Point3D(0, 0, 0))]), "F")  # a bool is not a parameter
    assert flagged[0]["meta"] == {"tag": "points"}


def test_indexed_labels_never_collide():
    assert indexed("P", 3) == "P₃"
    assert indexed("P", 12) == "P₁₂"
    assert indexed("P₁", 2) == "P₁,₂"
    assert indexed("Q₁₀", 1) == "Q₁₀,₁"


def test_clockwise_circle2d_gets_a_downward_frame():
    clockwise = {"type": "circle", "frame": {"o": [1.0, 2.0, 0.0], "x": [1.0, 0.0, 0.0], "y": [0.0, -1.0, 0.0],
                                            "z": [0.0, 0.0, -1.0]}, "r": 0.5}
    [part] = to_objects(fake("Circle2D", clockwise, center=Point3D(1.0, 2.0), radius=0.5))
    assert_frame(part["geom"]["frame"], clockwise["frame"])


def test_uv_curves():
    line = fake("Line2D", {"type": "line", "o": [0.0, 3.0, 0.0], "d": [1.0, 0.0, 0.0]},
                origin=Point3D(0.0, 3.0), direction=Vector3D(1.0, 0.0))
    assert uv_curve(line) == {"type": "line", "o": [0.0, 3.0, 0.0], "d": [1.0, 0.0, 0.0]}
    assert uv_curve([(0, 0), (math.pi, 1.5)]) == {"type": "polyline", "points": [[0.0, 0.0, 0.0], [math.pi, 1.5, 0.0]]}
    with pytest.raises(TypeError, match=r"\(u, v\)"):
        uv_curve([(0, 0, 1), (1, 1, 1)])
    with pytest.raises(TypeError, match="at least 2"):
        uv_curve([(0, 0)])
    with pytest.raises(TypeError, match="Line2D"):
        uv_curve(fake("Line3D", {"type": "line", "o": [0.0, 0.0, 0.0], "d": [1.0, 0.0, 0.0]}))


def test_real_geomcore_parametrize_on_gives_a_uv_curve():
    pytest.importorskip("geomcore")
    from geomcore import Point3D as P, Vector3D as V
    from geomcore.curves import Circle3D
    from geomcore.surfaces import Cylinder, Plane

    Y = Cylinder(P(0, 0, 0), world_z(V), 2.0)
    q = Circle3D(P(0, 0, 1.5), world_z(V), 2.0).parametrize_on(Y)
    assert uv_curve(q) == {"type": "line", "o": [0.0, 1.5, 0.0], "d": [1.0, 0.0, 0.0]}
    flipped = Circle3D(P(1, 1, 0), V(0, 0, -1), 0.5).parametrize_on(Plane(P(0, 0, 0), world_z(V)))
    assert uv_curve(flipped)["frame"]["z"] == pytest.approx([0.0, 0.0, -1.0])


# --- projection results (geomcore >= 0.36) ---------------------------------
class CurveProjection:
    def __init__(self, target, query_point, point, distance, parameter):
        self.target, self.query_point, self.point = target, query_point, point
        self.distance, self.parameter = distance, parameter


class CurveProjection2D(CurveProjection):
    pass


class SurfaceProjection:
    def __init__(self, target, query_point, point, distance, u, v):
        self.target, self.query_point, self.point = target, query_point, point
        self.distance, self.u, self.v = distance, u, v


X_LINE = {"type": "line", "o": [0.0, 0.0, 0.0], "d": [1.0, 0.0, 0.0]}
XY_PLANE = {"type": "plane", "frame": _frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])}


def test_curve_projection_draws_target_points_and_dashed_connector():
    line = fake("Line3D", X_LINE, origin=Point3D(0, 0, 0), direction=Vector3D(1, 0, 0))
    result = CurveProjection(line, Point3D(1, 2, 0), Point3D(1, 0, 0), 2.0, 1.0)
    parts = to_objects(result, "P")
    assert len(parts) == 4
    by_key = {p["key"]: p for p in parts}
    assert set(by_key) == {"P·target", "P·query", "P·closest", "P·distance"}
    assert all(p["group"] == "P" for p in parts)
    assert by_key["P·target"]["geom"]["type"] == "line"
    assert by_key["P·query"]["geom"] == {"type": "point", "p": [1.0, 2.0, 0.0]}
    assert by_key["P·closest"]["geom"] == {"type": "point", "p": [1.0, 0.0, 0.0]}
    assert by_key["P·query"]["label"] == "query point"
    assert by_key["P·closest"]["label"] == "closest point, d = 2"
    assert by_key["P·closest"]["style"]["color"] == ACCENT
    assert by_key["P·query"]["style"]["color"] not in (ACCENT, *PALETTE)
    connector = by_key["P·distance"]
    assert connector["geom"] == {"type": "polyline", "points": [[1.0, 2.0, 0.0], [1.0, 0.0, 0.0]]}
    assert connector["style"]["dashed"] is True
    assert by_key["P·closest"]["meta"] == {"tag": "projection", "params": [1.0]}


def test_curve_projection_2d_lifts_points_to_z_zero():
    circle = fake("Circle2D", {"type": "circle", "frame": _frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
                               "r": 1.0}, center=Point3D(0.0, 0.0), radius=1.0)
    parts = to_objects(CurveProjection2D(circle, Point3D(3, 0), Point3D(1, 0), 2.0, 0.0), "Q")
    assert len(parts) == 4
    assert parts[1]["geom"]["p"] == [3.0, 0.0, 0.0]
    assert parts[2]["geom"]["p"] == [1.0, 0.0, 0.0]


def test_surface_projection_windows_the_surface_around_the_closest_point():
    plane = fake("Plane", XY_PLANE)
    result = SurfaceProjection(plane, Point3D(10, 20, 3), Point3D(10, 20, 0), 3.0, 10.0, 20.0)
    parts = {p["key"]: p for p in to_objects(result, "S")}
    window = parts["S·target"]["geom"]["window"]
    for name, centre in (("u", 10.0), ("v", 20.0)):
        low, high = window[name]
        assert low < centre < high and (low + high) / 2 == pytest.approx(centre)
    assert parts["S·closest"]["meta"]["params"] == [10.0, 20.0]
    assert parts["S·closest"]["label"] == "closest point, d = 3"
    assert parts["S·distance"]["style"]["dashed"] is True


def test_projection_without_a_label_still_groups_and_names_its_parts():
    line = fake("Line3D", X_LINE, origin=Point3D(0, 0, 0), direction=Vector3D(1, 0, 0))
    parts = to_objects(CurveProjection(line, Point3D(1, 2, 0), Point3D(1, 0, 0), 2.0, 1.0))
    assert len({p["key"] for p in parts}) == 4
    assert {p["group"] for p in parts} == {"projection on Line3D"}
    again = to_objects(CurveProjection(line, Point3D(0, 5, 0), Point3D(0, 0, 0), 5.0, 0.0))
    assert {p["group"] for p in again} == {"projection on Line3D"}


def test_user_window_overrides_the_automatic_one():
    plane = fake("Plane", XY_PLANE)
    result = SurfaceProjection(plane, Point3D(10, 20, 3), Point3D(10, 20, 0), 3.0, 10.0, 20.0)
    [target, *_] = to_objects(result, "S", u=(0, 2), v=(-1, 1))
    assert target["geom"]["window"] == {"u": [0.0, 2.0], "v": [-1.0, 1.0]}


def test_bspline_surface_target_is_sampled_around_the_closest_point():
    surface = fake("BSplineSurface", XY_PLANE)
    result = SurfaceProjection(surface, Point3D(1, 2, 3), Point3D(1, 2, 0), 3.0, 1.0, 2.0)
    [target, *_] = to_objects(result, "B")
    assert target["geom"]["type"] == "mesh"
    xs = [p[0] for p in target["geom"]["vertices"]]
    assert min(xs) == pytest.approx(1.0 - 4.5) and max(xs) == pytest.approx(1.0 + 4.5)


def test_accent_never_matches_the_target_colour_on_a_fresh_viewer():
    from geomcore_viewer.viewer import Viewer

    viewer = Viewer.__new__(Viewer)
    viewer._next_color = 0
    viewer.objects = {}
    assert all(viewer._color() != ACCENT for _ in range(len(PALETTE) * 2))


def test_tuple_results_still_work_next_to_projections():
    assert [p["label"] for p in to_objects(("points", [Point3D(0, 0, 0), Point3D(1, 0, 0)]), "R")] == ["R₁", "R₂"]


def test_real_geomcore_projections():
    pytest.importorskip("geomcore")
    from geomcore import Point2D, Point3D as P, Vector3D as V
    from geomcore.curves import Circle2D, Line3D
    from geomcore.surfaces import Cylinder, Plane

    on_line = to_objects(Line3D(P(0, 0, 0), V(1, 0, 0)).project_point(P(1, 2, 0)), "A")
    assert len(on_line) == 4 and on_line[3]["geom"]["points"] == [[1.0, 2.0, 0.0], [1.0, 0.0, 0.0]]
    on_circle = to_objects(Circle2D(Point2D(0, 0), 1.0).project_point(Point2D(3, 0)), "B")
    assert len(on_circle) == 4
    on_plane = to_objects(Plane(P(0, 0, 0), world_z(V)).project_point(P(1, 2, 3)), "C")
    assert len(on_plane) == 4 and on_plane[0]["geom"]["window"]
    on_cylinder = to_objects(Cylinder(P(0, 0, 0), world_z(V), 2.0).project_point(P(5, 0, 1)), "D")
    assert on_cylinder[0]["geom"]["window"]["u"] == [0.0, TAU]


# --- intersection and extrema results (geomcore >= 0.36) --------------------
class Named:
    """Stand-in for a geomcore enum value: only ``.name`` is read."""

    def __init__(self, name):
        self.name = name


class Completeness:
    def __init__(self, status="COMPLETE", reason=None, regions=()):
        self.status, self.reason, self.regions = Named(status), reason, list(regions)


class Region:
    def __init__(self, min_corner, max_corner):
        self.min_corner, self.max_corner = min_corner, max_corner


class CurveCurveHit:
    def __init__(self, point, first_parameter, second_parameter, multiplicity=1):
        self.point, self.multiplicity = point, multiplicity
        self.first_parameter, self.second_parameter = first_parameter, second_parameter


class CurveCurveOverlap:
    def __init__(self, first_range, second_range):
        self.first_range, self.second_range, self.same_direction = first_range, second_range, True


class IntersectionCurve:
    def __init__(self, curve, tangent=False):
        self.curve, self.tangent = curve, tangent


class _Intersection:
    def __init__(self, first, second, *, method="EXACT", completeness=None, hits=(), overlaps=(), curves=(),
                 contact_points=(), coincident=False):
        self.first, self.second, self.method = first, second, Named(method)
        self.completeness = completeness or Completeness()
        self.hits, self.overlaps, self.curves = list(hits), list(overlaps), list(curves)
        self.contact_points, self._coincident = list(contact_points), coincident

    def is_coincident(self):
        return self._coincident

    def __bool__(self):
        return bool(self.hits or self.overlaps or self.curves or self.contact_points or self._coincident)


class CurveCurveIntersection(_Intersection):
    pass


class SurfaceSurfaceIntersection(_Intersection):
    pass


class CurveCurveExtremum:
    def __init__(self, distance, first_parameter, second_parameter):
        self.distance, self.first_parameter, self.second_parameter = distance, first_parameter, second_parameter


class CurveCurveExtrema:
    def __init__(self, first, second, minima):
        self.first, self.second, self.minima = first, second, list(minima)


class _XyProjection:
    def __init__(self, point):
        self.u, self.v = point.x, point.y


def xy_plane():
    plane = fake("Plane", XY_PLANE)
    type(plane).project_point = lambda self, point: _XyProjection(point)
    return plane


Y_LINE = {"type": "line", "o": [0.0, 1.0, 1.0], "d": [0.0, 1.0, 0.0]}
CIRCLE = {"type": "circle", "frame": _frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]), "r": 1.0}


def x_line():
    return fake("Line3D", X_LINE, origin=Point3D(0, 0, 0), direction=Vector3D(1, 0, 0))


def unit_circle():
    return fake("Circle3D", CIRCLE, center=Point3D(0, 0, 0), radius=1.0, normal=Vector3D(0, 0, 1))


def by_key(parts):
    return {p["key"]: p for p in parts}


def test_intersection_draws_operands_hits_method_and_one_group():
    result = CurveCurveIntersection(x_line(), unit_circle(), method="EXACT",
                                    hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0), CurveCurveHit(Point3D(-1, 0, 0), 1.0, 3.0)])
    parts = to_objects(result, "P")
    keys = by_key(parts)
    assert set(keys) == {"P·first", "P·second", "P·hit1", "P·hit2", "P·method"}
    assert {p["group"] for p in parts if "group" in p} == {"P"}
    assert all(p["group"] == "P" for p in parts if p["geom"]["type"] != "note")
    assert keys["P·first"]["style"] == {"opacity": 0.45} and keys["P·second"]["style"] == {"opacity": 0.45}
    assert keys["P·first"]["geom"]["type"] == "line" and keys["P·second"]["geom"]["type"] == "circle"
    assert keys["P·hit1"]["geom"] == {"type": "point", "p": [1.0, 0.0, 0.0]}
    assert keys["P·hit1"]["style"]["color"] == ACCENT and keys["P·hit1"]["label"] is None
    assert keys["P·hit2"]["meta"] == {"tag": "hit", "params": [1.0, 3.0]}
    assert keys["P·method"]["geom"] == {"type": "note", "text": "P: method: exact", "level": "info"}


def test_default_group_names_both_operands_and_is_deterministic():
    result = CurveCurveIntersection(x_line(), unit_circle(), hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0)])
    assert {p["group"] for p in to_objects(result) if "group" in p} == {"Line3D × Circle3D"}
    assert {p["key"] for p in to_objects(result)} == {p["key"] for p in to_objects(result)}


def test_tangent_hit_and_tangent_curve_are_labelled():
    result = SurfaceSurfaceIntersection(
        xy_plane(), xy_plane(),
        curves=[IntersectionCurve(unit_circle(), tangent=True), IntersectionCurve(x_line())],
        contact_points=[Point3D(0, 0, 0)],
    )
    keys = by_key(to_objects(result, "S"))
    assert keys["S·curve1"]["label"] == "tangent" and keys["S·curve2"]["label"] is None
    assert keys["S·curve1"]["geom"]["type"] == "circle" and keys["S·curve1"]["style"]["color"] == ACCENT
    assert keys["S·contact1"]["label"] == "tangent"
    double = CurveCurveIntersection(x_line(), unit_circle(), hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0, 2)])
    assert by_key(to_objects(double, "T"))["T·hit1"]["label"] == "tangent"


def test_overlap_is_the_operand_sampled_over_its_range():
    result = CurveCurveIntersection(x_line(), x_line(), overlaps=[CurveCurveOverlap((1.0, 3.0), (-5.0, 5.0))])
    overlap = by_key(to_objects(result, "O"))["O·overlap1"]
    assert overlap["geom"]["type"] == "polyline" and overlap["style"]["color"] == ACCENT
    xs = [p[0] for p in overlap["geom"]["points"]]
    assert xs[0] == pytest.approx(1.0) and xs[-1] == pytest.approx(3.0)


def test_unbounded_overlap_falls_back_to_the_bounded_operand_then_the_whole_operand():
    inf = float("inf")
    second_bounded = CurveCurveIntersection(x_line(), x_line(), overlaps=[CurveCurveOverlap((-inf, inf), (2.0, 4.0))])
    xs = [p[0] for p in by_key(to_objects(second_bounded, "A"))["A·overlap1"]["geom"]["points"]]
    assert xs[0] == pytest.approx(2.0) and xs[-1] == pytest.approx(4.0)
    both = CurveCurveIntersection(x_line(), x_line(), overlaps=[CurveCurveOverlap((-inf, inf), (-inf, inf))])
    whole = by_key(to_objects(both, "B"))["B·overlap1"]
    assert whole["geom"]["type"] == "line" and whole["style"]["color"] == ACCENT


def test_incomplete_result_warns_and_draws_each_region_as_a_dashed_box():
    regions = [Region(Point3D(0, 0, 0), Point3D(1, 2, 3)), Region(Point3D(5, 5, 5), Point3D(6, 6, 6))]
    result = SurfaceSurfaceIntersection(xy_plane(), xy_plane(),
                                        completeness=Completeness("INCOMPLETE", "iteration limit", regions))
    parts = to_objects(result, "I")
    keys = by_key(parts)
    assert keys["I·status"]["geom"]["level"] == "warn" and "iteration limit" in keys["I·status"]["geom"]["text"]
    for index, (low, high) in enumerate(((0, 1), (5, 6)), start=1):
        box = keys[f"I·region{index}"]
        assert box["style"]["dashed"] is True and box["style"]["color"] == ACCENT and box["group"] == "I"
        points = box["geom"]["points"]
        assert box["geom"]["type"] == "polyline"
        assert {c for p in points for c in p} <= {float(low), float(high), 2.0, 3.0, 5.0, 6.0}
        assert min(p[0] for p in points) == low and max(p[0] for p in points) == high


def test_box_path_covers_all_twelve_segments():
    result = SurfaceSurfaceIntersection(xy_plane(), xy_plane(),
                                        completeness=Completeness("INCOMPLETE", None,
                                                                  [Region(Point3D(0, 0, 0), Point3D(1, 1, 1))]))
    points = by_key(to_objects(result, "I"))["I·region1"]["geom"]["points"]
    covered = {frozenset((tuple(a), tuple(b))) for a, b in zip(points, points[1:])}
    assert len(covered) == 12
    assert all(sum(x != y for x, y in zip(a, b)) == 1 for a, b in map(tuple, covered))


def test_sampled_result_gets_an_info_note():
    result = CurveCurveIntersection(x_line(), unit_circle(), completeness=Completeness("SAMPLED"),
                                    hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0)])
    note = by_key(to_objects(result, "M"))["M·status"]["geom"]
    assert note["level"] == "info" and "sampled" in note["text"]


def test_complete_result_has_no_status_note():
    result = CurveCurveIntersection(x_line(), unit_circle(), hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0)])
    assert "M·status" not in by_key(to_objects(result, "M"))


def test_empty_intersection_keeps_operands_and_says_empty():
    keys = by_key(to_objects(CurveCurveIntersection(x_line(), unit_circle()), "E"))
    assert keys["E·note"]["geom"]["text"] == "E: ∅"
    assert {"E·first", "E·second", "E·method"} <= set(keys)


def test_coincident_surfaces_get_a_note():
    result = SurfaceSurfaceIntersection(xy_plane(), xy_plane(), coincident=True)
    assert "coincident" in by_key(to_objects(result, "C"))["C·coincident"]["geom"]["text"]


def test_reason_is_named_not_shown_as_an_enum_repr():
    reason = Named("BUDGET_EXHAUSTED")
    result = SurfaceSurfaceIntersection(xy_plane(), xy_plane(), completeness=Completeness("INCOMPLETE", reason, []))
    text = by_key(to_objects(result, "I"))["I·status"]["geom"]["text"]
    assert text.endswith("missing: budget exhausted")


def test_user_style_wins_over_recipe_defaults():
    from geomcore_viewer.viewer import Viewer

    viewer = Viewer.__new__(Viewer)
    viewer._next_color, viewer._next_auto, viewer.run, viewer.objects = 0, 0, "abcdef", {}
    result = CurveCurveIntersection(x_line(), unit_circle(), hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0)])
    built = [viewer._build(p, {"opacity": 0.2, "color": "#000000"}, None, {}, None, None)
             for p in to_objects(result, "U") if p["geom"]["type"] != "note"]
    assert all(o["style"]["color"] == "#000000" for o in built)
    assert [o["style"].get("opacity") for o in built] == [0.2, 0.2, None]


def test_user_opacity_applies_to_the_operands_only():
    from geomcore_viewer.viewer import Viewer

    viewer = Viewer.__new__(Viewer)
    viewer._next_color, viewer._next_auto, viewer.run, viewer.objects = 0, 0, "abcdef", {}
    result = CurveCurveIntersection(x_line(), unit_circle(), overlaps=[CurveCurveOverlap((1.0, 3.0), (0.0, 1.0))],
                                    hits=[CurveCurveHit(Point3D(1, 0, 0), 0.0, 0.0)])
    built = {p["key"]: viewer._build(p, {"opacity": 0.2}, None, {}, None, None)
             for p in to_objects(result, "U") if p["geom"]["type"] != "note"}
    assert built["U·first"]["style"]["opacity"] == built["U·second"]["style"]["opacity"] == 0.2
    for key in ("U·hit1", "U·overlap1"):
        assert "opacity" not in built[key]["style"]


def test_extrema_draw_a_dashed_segment_per_minimum_labelled_with_its_distance():
    first, second = x_line(), fake("Line3D", Y_LINE, origin=Point3D(0, 1, 1), direction=Vector3D(0, 1, 0))
    parts = to_objects(CurveCurveExtrema(first, second, [CurveCurveExtremum(1.0, 0.0, -1.0)]), "X")
    keys = by_key(parts)
    assert {p["group"] for p in parts} == {"X"}
    segment = keys["X·minimum1"]
    assert segment["geom"] == {"type": "polyline", "points": [[0.0, 0.0, 0.0], [0.0, 0.0, 1.0]]}
    assert segment["style"] == {"color": ACCENT, "dashed": True}
    assert segment["label"] == "d = 1"
    assert segment["meta"] == {"tag": "extremum", "params": [0.0, -1.0]}
    assert keys["X·first"]["style"] == {"opacity": 0.45}


def test_extrema_without_minima_say_empty_and_default_group_is_named():
    parts = to_objects(CurveCurveExtrema(x_line(), unit_circle(), []))
    assert {p["group"] for p in parts if "group" in p} == {"Line3D × Circle3D extrema"}
    assert any(p["geom"].get("text", "").endswith("∅") for p in parts)


def test_trimmed_operand_is_sampled_over_its_bounds():
    trimmed = type("TrimmedCurve3D", (), {
        "bounds": lambda self: (1.0, 2.0),
        "eval_point": lambda self, t: Point3D(t, 0.0, 0.0),
    })()
    result = CurveCurveIntersection(trimmed, unit_circle(), hits=[CurveCurveHit(Point3D(1, 0, 0), 1.0, 0.0)])
    geom = by_key(to_objects(result, "T"))["T·first"]["geom"]
    assert geom["type"] == "polyline" and geom["points"][0][0] == 1.0 and geom["points"][-1][0] == 2.0


def test_real_geomcore_intersections_and_extrema_display():
    pytest.importorskip("geomcore")
    import geomcore
    from geomcore import Point2D, Point3D as P, Vector2D, Vector3D as V
    from geomcore.curves import Circle2D, Circle3D, Line2D, Line3D
    from geomcore.surfaces import Plane, Sphere

    if not hasattr(geomcore, "CurveCurveIntersection"):
        pytest.skip("needs geomcore >= 0.36")
    unit_z = world_z(V)
    line = Line3D(P(0, 0, 0), V(1, 0, 0))
    tangent_line = Line3D(P(1, -1, 0), V(0, 1, 0))
    tangent = to_objects(Circle3D(P(0, 0, 0), unit_z, 1.0).intersect(tangent_line), "A")
    assert by_key(tangent)["A·hit1"]["label"] == "tangent"
    overlap = to_objects(line.intersect(Line3D(P(2, 0, 0), V(1, 0, 0))), "B")
    assert by_key(overlap)["B·overlap1"]["geom"]["type"] == "line"
    plane_sphere = to_objects(Plane(P(0, 0, 0), unit_z).intersect(Sphere(P(0, 0, 0), 1.0)), "C")
    assert by_key(plane_sphere)["C·curve1"]["geom"]["type"] == "circle"
    assert by_key(plane_sphere)["C·method"]["geom"]["text"] == "C: method: exact"
    pierced = to_objects(Line3D(P(0, 0, 0), V(0, 0, 1)).intersect(Sphere(P(0, 0, 0), 1.0)), "D")
    assert {"D·hit1", "D·hit2"} <= set(by_key(pierced))
    flat = to_objects(Circle2D(Point2D(0, 0), 1.0).intersect(Line2D(Point2D(1, 0), Vector2D(0, 1))), "E")
    assert by_key(flat)["E·hit1"]["geom"]["p"] == [1.0, 0.0, 0.0]
    empty = to_objects(Plane(P(0, 0, 0), unit_z).intersect(Plane(P(0, 0, 1), unit_z)), "F")
    assert by_key(empty)["F·note"]["geom"]["text"] == "F: ∅"
    extrema = to_objects(geomcore.curve_curve_extrema(line, Line3D(P(0, 1, 1), V(0, 1, 0))), "G")
    assert by_key(extrema)["G·minimum1"]["label"] == "d = 1"


def test_unbounded_operand_window_follows_the_result_not_the_scene():
    plane = xy_plane()
    far = Region(Point3D(100, 200, 0), Point3D(110, 230, 0))
    result = SurfaceSurfaceIntersection(plane, unit_circle_surface(), completeness=Completeness("INCOMPLETE", None, [far]))
    window = by_key(to_objects(result, "W"))["W·first"]["geom"]["window"]
    assert window["u"][0] < 100 and window["u"][1] > 110 and window["v"][0] < 200 and window["v"][1] > 230
    again = by_key(to_objects(result, "W"))["W·first"]["geom"]["window"]
    assert again == window


def test_unbounded_operand_without_anything_finite_gets_a_fixed_window():
    window = by_key(to_objects(SurfaceSurfaceIntersection(xy_plane(), xy_plane()), "N"))["N·first"]["geom"]["window"]
    assert window == {"u": [-5.0, 5.0], "v": [-5.0, 5.0]}


def test_user_window_wins_over_the_operand_window():
    result = SurfaceSurfaceIntersection(xy_plane(), xy_plane())
    window = by_key(to_objects(result, "N", u=(0, 2), v=(-1, 1)))["N·first"]["geom"]["window"]
    assert window == {"u": [0.0, 2.0], "v": [-1.0, 1.0]}


def unit_circle_surface():
    """A bounded surface stand-in: a sphere named as geomcore's."""
    return fake("Sphere", {"type": "sphere", "frame": _frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
                           "r": 1.0}, center=Point3D(0, 0, 0), radius=1.0)


def _live():
    pytest.importorskip("geomcore")
    import geomcore

    if not hasattr(geomcore, "CurveCurveIntersection"):
        pytest.skip("needs geomcore >= 0.36")
    return geomcore


def test_live_line_in_plane_overlap_does_not_crash():
    _live()
    from geomcore import Point3D as P, Vector3D as V
    from geomcore.curves import Line3D
    from geomcore.surfaces import Plane

    result = Line3D(P(0, 0, 0), V(1, 0, 0)).intersect(Plane(P(0, 0, 0), world_z(V)))
    keys = by_key(to_objects(result, "L"))
    assert keys["L·overlap1"]["geom"]["type"] == "line"
    assert keys["L·second"]["geom"]["window"]["u"][0] < 0 < keys["L·second"]["geom"]["window"]["u"][1]


def test_live_plane_sphere_window_is_local_whatever_the_scene_holds():
    _live()
    from geomcore import Point3D as P, Vector3D as V
    from geomcore.surfaces import Plane, Sphere
    from geomcore_viewer.viewer import Viewer

    result = Plane(P(500, 500, 0), world_z(V)).intersect(Sphere(P(510, 500, 1), 3.0))
    viewer = Viewer.__new__(Viewer)
    viewer._next_color, viewer._next_auto, viewer.run, viewer.objects = 0, 0, "abcdef", {}
    viewer.objects["far"] = {"id": "far", "geom": {"type": "point", "p": [9000.0, 0.0, 0.0]}}
    window = by_key(to_objects(result, "S"))["S·first"]["geom"]["window"]
    built = viewer._build(by_key(to_objects(result, "S"))["S·first"], {}, None, {}, None, None)
    assert built["geom"]["window"] == window
    u0, u1 = window["u"]
    assert u0 < 7 and u1 > 13 and u1 - u0 < 20


def test_live_every_result_family_displays():
    geomcore = _live()
    from geomcore import Point2D, Point3D as P, Vector2D, Vector3D as V
    from geomcore.curves import Circle2D, Circle3D, Line2D, Line3D
    from geomcore.surfaces import Cone, Cylinder, Plane, Sphere

    z = world_z(V)
    results = {
        "curve-curve": Circle3D(P(0, 0, 0), z, 1.0).intersect(Line3D(P(0, 0, 0), V(1, 0, 0))),
        "curve-curve 2D": Circle2D(Point2D(0, 0), 1.0).intersect(Line2D(Point2D(0, 0), Vector2D(1, 0))),
        "curve-surface": Line3D(P(0, 0, -2), z).intersect(Cylinder(P(0, 0, 0), z, 1.0)),
        "surface-surface": Cylinder(P(0, 0, 0), z, 2.0).intersect(Plane(P(0, 0, 0), V(1, 0, 0))),
        "cone-sphere": Cone.from_frame(__import__("geomcore").Frame3D.world(), 0.4, 2.0).intersect(
            Sphere(P(0, 0, 0), 3.0)),
        "extrema": geomcore.curve_curve_extrema(Line3D(P(0, 0, 0), V(1, 0, 0)), Line3D(P(0, 1, 1), V(0, 1, 0))),
    }
    for name, result in results.items():
        parts = to_objects(result, "R")
        assert {p["group"] for p in parts if "group" in p} == {"R"}, name
        for part in parts:
            window = part["geom"].get("window")
            if window:
                assert all(abs(c) < 100 for bounds in window.values() for c in bounds), name


def _live_curve_in_plane_cases():
    from geomcore import Point3D as P, Vector3D as V
    from geomcore.curves import Circle3D, Line3D
    from geomcore.surfaces import Plane

    z = V.unit_z()
    plane = Plane(P(0, 0, 0), z)
    return {
        "circle": (plane, Circle3D(P(0, 0, 0), z, 2.0), 4.0 * math.pi),
        "line": (plane, Line3D(P(0, 0, 0), V(1, 0, 0)), None),
    }


@pytest.mark.parametrize("name", ["circle", "line"])
@pytest.mark.parametrize("surface_first", [True, False])
def test_live_curve_in_plane_overlap_samples_the_curve_whatever_the_receiver(name, surface_first):
    _live()
    plane, curve, _ = _live_curve_in_plane_cases()[name]
    result = plane.intersect(curve) if surface_first else curve.intersect(plane)
    overlap = by_key(to_objects(result, "O"))["O·overlap1"]
    if name == "circle":
        assert overlap["geom"]["type"] == "polyline"
        radii = {round(math.hypot(p[0], p[1]), 6) for p in overlap["geom"]["points"]}
        assert radii == {2.0}
        assert {p[2] for p in overlap["geom"]["points"]} == {0.0}
    else:
        assert overlap["geom"]["type"] in ("line", "polyline")


def test_curve_operand_prefers_the_curve_property_then_falls_back_to_the_type():
    from geomcore_viewer.adapt import _curve_operand

    class Result:
        first, second = "surface-ish", "curve-ish"

    with_property = Result()
    with_property.curve = "the curve"
    assert _curve_operand(with_property) == "the curve"
    plane = fake("Plane", {"type": "plane"})
    line = fake("Line3D", {"type": "line"})

    class ByType:
        def __init__(self, first, second):
            self.first, self.second = first, second

    assert _curve_operand(ByType(plane, line)) is line
    assert _curve_operand(ByType(line, plane)) is line


def test_live_projection_onto_a_trimmed_curve_draws_the_trimmed_range():
    _live()
    from geomcore import Point2D, Point3D as P, Vector2D, Vector3D as V
    from geomcore.curves import Circle2D, Circle3D, Line2D, Line3D, TrimmedCurve2D, TrimmedCurve3D

    trimmed_3d = TrimmedCurve3D(Line3D(P(0, 0, 0), V(1, 0, 0)), 1.0, 3.0)
    parts = to_objects(trimmed_3d.project_point(P(2, 1, 0)), "T")
    target = by_key(parts)["T·target"]
    assert target["geom"]["type"] == "polyline"
    assert {p[0] for p in target["geom"]["points"]} >= {1.0, 3.0}
    assert min(p[0] for p in target["geom"]["points"]) == 1.0 and max(p[0] for p in target["geom"]["points"]) == 3.0

    trimmed_2d = TrimmedCurve2D(Line2D(Point2D(0, 0), Vector2D(1, 0)), 1.0, 3.0)
    parts_2d = to_objects(trimmed_2d.project_point(Point2D(2, 1)), "U")
    target_2d = by_key(parts_2d)["U·target"]
    assert target_2d["geom"]["type"] == "polyline"
    assert by_key(parts_2d)["U·closest"]["geom"]["p"][2] == 0.0


def test_live_default_group_names_are_identical_across_two_calls():
    _live()
    from geomcore import Point3D as P, Vector3D as V
    from geomcore.curves import Circle3D, Line3D

    circle, line = Circle3D(P(0, 0, 0), V.unit_z(), 1.0), Line3D(P(0, 0, 0), V(1, 0, 0))
    first_call = to_objects(circle.intersect(line))
    second_call = to_objects(circle.intersect(line))
    assert [(p["key"], p.get("group")) for p in first_call] == [(p["key"], p.get("group")) for p in second_call]
    assert {p["group"] for p in first_call if "group" in p} == {"Circle3D × Line3D"}


def test_live_2d_closest_point_is_lifted_to_z_zero():
    _live()
    from geomcore import Point2D
    from geomcore.curves import Circle2D

    parts = to_objects(Circle2D(Point2D(0, 0), 1.0).project_point(Point2D(3, 0)), "Q")
    keys = by_key(parts)
    assert keys["Q·closest"]["geom"]["p"] == pytest.approx([1.0, 0.0, 0.0])
    assert keys["Q·query"]["geom"]["p"] == pytest.approx([3.0, 0.0, 0.0])
