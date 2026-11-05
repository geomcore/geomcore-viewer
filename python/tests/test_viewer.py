import json
import math
import re
import socket
import sys
import urllib.request
import warnings
from pathlib import Path

import pytest

import geomcore_viewer as gv
from geomcore_viewer import PALETTE, Server, Viewer


class Point3D:
    def __init__(self, x, y, z=0.0):
        self.x, self.y, self.z = x, y, z


class Plane:
    def eval_point(self, u, v):
        return Point3D(u, v, 0.0)


class Named:
    def __init__(self, name):
        self.name = name


class Complete:
    status = Named("COMPLETE")


class Line3D:
    def __init__(self, o, d):
        self.o, self.d = o, d

    def origin(self):
        return self.o

    def direction(self):
        return self.d

    def eval_point(self, t):
        return Point3D(self.o.x + t * self.d.x, self.o.y + t * self.d.y, self.o.z + t * self.d.z)


class CurveCurveIntersection:
    """The parts of a geomcore result object that the adapter reads."""

    method = Named("EXACT")
    completeness = Complete()
    hits = curves = overlaps = contact_points = ()

    def __init__(self, first, second):
        self.first, self.second = first, second


def test_a_result_reuses_operands_already_in_the_scene(server):
    view = make(server)
    a = Line3D(Point3D(0, 0, 0), Point3D(1, 1, 0))
    b = Line3D(Point3D(0, 1, 0), Point3D(1, -1, 0))
    view.add(a, label="A")
    view.add(CurveCurveIntersection(a, b), label="X")
    ids = _ids(server)
    assert "X·first" not in ids  # A is already drawn
    assert "X·second" in ids
    view.add(CurveCurveIntersection(a, b), label="Y", operands=False)
    ids = _ids(server)
    assert not any(i.startswith("Y·first") or i.startswith("Y·second") for i in ids)


def test_re_adding_a_result_under_its_label_keeps_its_operands(server):
    """The label's own family is being replaced, so its operands must not count as already shown."""
    view = make(server)
    a = Line3D(Point3D(0, 0, 0), Point3D(1, 1, 0))
    b = Line3D(Point3D(0, 1, 0), Point3D(1, -1, 0))
    view.add(CurveCurveIntersection(a, b), label="X")
    view.add(CurveCurveIntersection(a, b), label="X")
    ids = _ids(server)
    assert "X·first" in ids and "X·second" in ids


@pytest.fixture
def server(tmp_path):
    srv = Server(tmp_path, port=0).start()
    yield srv
    srv.stop()


def _scene(server):
    with urllib.request.urlopen(f"{server.url}/api/scene", timeout=5) as res:
        return json.loads(res.read())


def _ids(server):
    return [o["id"] for o in _scene(server)["objects"]]


def make(server, **kw):
    return Viewer(url=server.url, open_browser=False, **kw)


def test_add_streams_point_with_label_and_palette_color(server):
    view = make(server, title="demo")
    handle = view.add(Point3D(1, 2, 3), label="A")
    scene = _scene(server)
    assert handle.id == "A"
    [obj] = scene["objects"]
    assert obj["geom"] == {"type": "point", "p": [1.0, 2.0, 3.0]}
    assert obj["label"] == "A" and obj["source"] == "Point3D"
    assert obj["style"]["color"] == PALETTE[0]
    assert scene["title"] == "demo" and scene["run"] == view.run


def test_same_label_updates_in_place_and_keeps_color(server):
    view = make(server)
    view.add(Point3D(0, 0), label="x")
    view.add(Point3D(9, 9), label="other")
    view.add(Point3D(1, 0), label="x")
    objs = {o["id"]: o for o in _scene(server)["objects"]}
    assert list(objs) == ["x", "other"]
    assert objs["x"]["geom"]["p"] == [1.0, 0.0, 0.0]
    assert objs["x"]["style"]["color"] == PALETTE[0]


def test_relabelled_result_drops_stale_members(server):
    view = make(server)
    view.add(("points", [Point3D(0, 0), Point3D(1, 0)]), label="P")
    assert _ids(server) == ["P₁", "P₂"]
    view.add(("empty", None), label="P")
    [note] = _scene(server)["objects"]
    assert note["id"] == "P·note" and note["geom"]["text"] == "P: ∅" and "style" not in note


def test_several_objects_get_subscripted_labels(server):
    handles = make(server).add(Point3D(0, 0), Point3D(1, 1), label="Q")
    assert [h.id for h in handles] == ["Q₁", "Q₂"]


def test_unlabelled_objects_get_unique_ids(server):
    view = make(server)
    a, b = view.add(Point3D(0, 0)), view.add(Point3D(1, 0))
    assert a.id != b.id and _ids(server) == [a.id, b.id]


def test_new_viewer_replaces_scene_and_keep_accumulates(server):
    make(server).add(Point3D(0, 0), label="a")
    make(server).add(Point3D(0, 0), label="b")
    assert _ids(server) == ["b"]
    make(server, keep=True).add(Point3D(0, 0), label="c")
    assert _ids(server) == ["b", "c"]


def test_handle_update_and_remove(server):
    view = make(server)
    handle = view.add(Point3D(0, 0), label="a")
    handle.update(color="#000000", width=4)
    assert _scene(server)["objects"][0]["style"] == {"color": "#000000", "width": 4}
    with pytest.raises(TypeError, match="colour"):
        handle.update(colour="red")
    handle.remove()
    assert _ids(server) == []


def test_remove_label_with_special_characters(server):
    view = make(server)
    handle = view.add(Point3D(0, 0), label="a/b c₁")
    assert _ids(server) == ["a/b c₁"]
    handle.remove()
    assert _ids(server) == []


def test_surface_gets_default_window_from_scene(server):
    view = make(server)
    view.add(Point3D(2, 0, 0))
    view.add(Plane(), label="pl")
    plane = _scene(server)["objects"][1]
    assert plane["geom"]["window"] == {"u": [-3.0, 3.0], "v": [-3.0, 3.0]}
    view.add(Plane(), label="pl", u=(0, 1))
    assert _scene(server)["objects"][1]["geom"]["window"]["u"] == [0.0, 1.0]


def test_extras_are_validated(server):
    view = make(server)
    view.add(Point3D(0, 0), label="a", foci=True)
    assert _scene(server)["objects"][0]["extras"] == {"foci": True}
    with pytest.raises(TypeError, match="colour"):
        view.add(Point3D(0, 0), colour="red")


def test_nan_geometry_is_rejected(server):
    view = make(server)
    with pytest.raises(ValueError, match="bad.*NaN"):
        view.add(Point3D(math.nan, 0), label="bad")
    assert view.objects == {} and _ids(server) == []


def test_steps_hold_their_own_objects(server):
    view = make(server)
    view.add(Point3D(0, 0), label="fixed")
    for name in ("tilt 0°", "tilt 45°"):
        with view.step(name):
            view.add(Point3D(1, 0), label="cone")
            view.add(Point3D(2, 0), label="plane")
    scene = _scene(server)
    assert scene["steps"] == ["tilt 0°", "tilt 45°"]
    objects = scene["objects"]
    assert [o["id"] for o in objects if "step" not in o] == ["fixed"]
    assert {o["step"] for o in objects if "step" in o} == {"tilt 0°", "tilt 45°"}
    cones = [o for o in objects if o["label"] == "cone"]
    assert len(cones) == 2 and len({o["id"] for o in cones}) == 2
    assert all(o["id"].startswith(o["step"] + "·") for o in cones)


def test_re_running_a_step_replaces_only_that_step(server):
    view = make(server)
    with view.step("a"):
        view.add(Point3D(0, 0), label="P")
    with view.step("b"):
        view.add(Point3D(1, 0), label="P")
    with view.step("a"):
        view.add(Point3D(2, 0), label="P")
    ps = [o for o in _scene(server)["objects"] if o["label"] == "P"]
    assert sorted((o["step"], o["geom"]["p"][0]) for o in ps) == [("a", 2.0), ("b", 1.0)]


def test_clear_forgets_the_steps(server):
    view = make(server)
    with view.step("a"):
        view.add(Point3D(0, 0), label="P")
    view.clear()
    assert view.steps == [] and _scene(server)["steps"] == []


def test_an_empty_step_still_reaches_the_page(server):
    view = make(server)
    with view.step("empty"):
        pass
    assert _scene(server)["steps"] == ["empty"]


def test_steps_do_not_nest(server):
    view = make(server)
    with view.step("outer"):
        with pytest.raises(ValueError, match="do not nest"):
            with view.step("inner"):
                pass
    assert view.steps == ["outer"]


def test_clear_inside_a_step_keeps_filling_that_step(server):
    view = make(server)
    with view.step("a"):
        view.clear()
        view.add(Point3D(0, 0), label="P")
    assert view.steps == ["a"] and view.objects["a·P"]["step"] == "a"
    assert _scene(server)["steps"] == ["a"]


def test_pcurve_on_a_label_inside_a_step_finds_that_steps_surface(server):
    view = make(server)
    with view.step("s"):
        view.add(Plane(), label="pl", u=(0, 4), v=(0, 2))
        view.pcurve([(0, 0), (4, 2)], on="pl", label="diag")
    assert view.objects["s·diag"]["geom"]["surface"] == "s·pl"


def test_a_result_redraws_an_operand_shown_only_in_another_step(server):
    view = make(server)
    a = Line3D(Point3D(0, 0, 0), Point3D(1, 1, 0))
    b = Line3D(Point3D(0, 1, 0), Point3D(1, -1, 0))
    with view.step("one"):
        view.add(a, label="A")
    with view.step("two"):
        view.add(CurveCurveIntersection(a, b), label="X")
    assert "two·X·first" in _ids(server)  # A is not on screen in step "two"


def test_steps_are_on_the_saved_scene(tmp_path):
    view = gv.Viewer(spawn=False, open_browser=False)
    with view.step("one"):
        view.add(Point3D(0, 0), label="P")
    saved = json.loads(view.save(tmp_path / "s.json").read_text())
    assert saved["steps"] == ["one"] and saved["objects"][0]["step"] == "one"


def test_points_builds_one_cloud_object(server):
    view = make(server)
    view.points([(0, 0, 0), (1, 0, 0), (0, 1, 0)], values=[0, 0.5, 1], colormap="plasma", size=4, label="dev")
    [obj] = _scene(server)["objects"]
    assert obj["geom"] == {
        "type": "points",
        "positions": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        "size": 4.0,
        "values": [0.0, 0.5, 1.0],
        "colormap": "plasma",
    }
    assert obj["label"] == "dev"


def test_mesh_takes_per_vertex_values(server):
    view = make(server)
    view.mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [0, 1, 2], values=[1, 2, 3], label="m")
    [obj] = _scene(server)["objects"]
    assert obj["geom"]["values"] == [1.0, 2.0, 3.0] and obj["geom"]["colormap"] == "viridis"


def test_scalar_fields_need_one_finite_value_per_element(server):
    view = make(server)
    with pytest.raises(ValueError, match="one number per point"):
        view.points([(0, 0), (1, 1)], values=[1])
    with pytest.raises(ValueError, match="finite"):
        view.points([(0, 0)], values=[float("nan")])
    with pytest.raises(ValueError, match="one number per vertex"):
        view.mesh([(0, 0), (1, 0), (0, 1)], [0, 1, 2], values=[1, 2])
    with pytest.raises(ValueError, match="needs values"):
        view.points([(0, 0)], colormap="viridis")
    with pytest.raises(ValueError, match="needs values"):
        view.mesh([(0, 0), (1, 0), (0, 1)], [0, 1, 2], colormap="viridis")


def test_points_and_mesh_take_numpy_arrays(server):
    np = pytest.importorskip("numpy")
    view = make(server)
    view.points(np.array([[0.0, 0.0], [1.0, 1.0]]), values=np.array([0.25, 0.75]), label="p")
    view.mesh(np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]), [0, 1, 2], values=np.array([1.0, 2.0, 3.0]), label="m")
    geoms = {o["id"]: o["geom"] for o in _scene(server)["objects"]}
    assert geoms["p"]["positions"] == [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]
    assert geoms["p"]["values"] == [0.25, 0.75]
    assert geoms["m"]["values"] == [1.0, 2.0, 3.0]
    json.dumps(_scene(server))  # every numpy scalar became a JSON number


def test_escape_hatches_coerce_inputs(server):
    view = make(server)
    view.polyline(((0, 0), (1, 1)), label="pl")
    view.mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], (i for i in range(3)), label="m")
    view.arrow((0, 0, 0), Point3D(1, 0, 0), label="ar")
    view.text([1, 1], 42, label="tx")
    geoms = {o["id"]: o["geom"] for o in _scene(server)["objects"]}
    assert geoms["pl"] == {"type": "polyline", "points": [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]}
    assert geoms["m"]["indices"] == [0, 1, 2]
    assert geoms["ar"] == {"type": "arrow", "at": [0.0, 0.0, 0.0], "vec": [1.0, 0.0, 0.0]}
    assert geoms["tx"] == {"type": "text", "at": [1.0, 1.0, 0.0], "text": "42"}


def test_batch_sends_once_at_the_end(server):
    view = make(server)
    calls = []

    def record(method, path, body, **kwargs):
        calls.append(path)
        return True

    view._request = record
    with view.batch():
        view.arrow((0, 0, 0), (1, 0, 0))
        view.arrow((0, 1, 0), (1, 0, 0))
        with view.batch():  # nested: still one send
            view.polyline([(0, 0), (1, 1)])
        assert calls == []  # nothing sent mid-block
    assert calls == ["/api/objects"]
    assert len(view.objects) == 3


def test_batch_flushes_once_even_when_the_block_raises(server):
    view = make(server)
    calls = []
    view._request = lambda method, path, body, **kwargs: calls.append(path) or True
    with pytest.raises(ValueError, match="boom"):
        with view.batch():
            view.arrow((0, 0, 0), (1, 0, 0))
            raise ValueError("boom")
    assert calls == ["/api/objects"]


def test_list_inputs_draw_many_shapes_in_one_call(server):
    view = make(server)
    view.polyline([[(0, 0), (1, 0)], [(0, 1), (1, 1)]], label="L")
    view.arrow([(0, 0, 0), (1, 1, 0)], [(1, 0, 0), (0, 1, 0)], label="A")
    view.text([(0, 0), (1, 1)], "hi", label="T")
    view.text([(0, 0), (1, 1)], ["a", "b"], label="U")
    view.polyline([(0, 0), (1, 1)], label="one")  # a single polyline still works
    geoms = {o["id"]: o["geom"] for o in _scene(server)["objects"]}
    assert geoms["L₁"]["points"] == [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
    assert geoms["L₂"]["points"] == [[0.0, 1.0, 0.0], [1.0, 1.0, 0.0]]
    assert geoms["A₂"] == {"type": "arrow", "at": [1.0, 1.0, 0.0], "vec": [0.0, 1.0, 0.0]}
    assert geoms["T₁"]["text"] == "hi" and geoms["T₂"]["at"] == [1.0, 1.0, 0.0]
    assert [geoms["U₁"]["text"], geoms["U₂"]["text"]] == ["a", "b"]
    assert geoms["one"]["points"] == [[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]


def test_list_inputs_need_the_same_number_of_items(server):
    view = make(server)
    with pytest.raises(TypeError, match="same number"):
        view.arrow([(0, 0), (1, 1)], [(1, 0), (0, 1), (2, 2)])
    with pytest.raises(TypeError, match="same number"):
        view.text([(0, 0), (1, 1)], ["a", "b", "c"])


def test_offline_buffers_warns_once_then_flushes(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    view = Viewer(url=f"http://127.0.0.1:{port}", open_browser=False, spawn=False)
    with pytest.warns(RuntimeWarning, match="no geomcore-viewer"):
        view.add(Point3D(0, 0), label="a")
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        view.add(Point3D(1, 0), label="b")
    saved = json.loads(view.save(tmp_path / "s.json").read_text())
    assert saved["version"] == 2 and [o["id"] for o in saved["objects"]] == ["a", "b"]
    srv = Server(tmp_path, port=port).start()
    try:
        view.add(Point3D(2, 0), label="c")
        assert _ids(srv) == ["a", "b", "c"]
    finally:
        srv.stop()


def test_module_level_add_uses_latest_viewer(server):
    view = make(server)
    gv.add(Point3D(0, 0), label="m")
    assert gv.viewer() is view and _ids(server) == ["m"]
    gv.clear()
    assert _ids(server) == []


def test_argument_errors(server):
    with pytest.raises(TypeError):
        make(server).add()
    with pytest.raises(ValueError):
        Viewer(view="4d")


def test_duplicate_note_ids_collapse_to_one_handle(server):
    handle = make(server).add(("tangent", None), label="X")
    assert isinstance(handle, gv.Handle) and handle.id == "X·note"
    [obj] = _scene(server)["objects"]
    assert obj["id"] == "X·note" and obj["geom"]["level"] == "warn"


def test_bad_style_value_leaves_viewer_usable(server):
    view = make(server)
    with pytest.raises(ValueError, match="bad.*NaN"):
        view.add(Point3D(0, 0), label="bad", opacity=math.nan)
    with pytest.raises(TypeError, match="bad"):
        view.add(Point3D(0, 0), label="bad", width=object())
    assert view.objects == {}
    view.add(Point3D(1, 0), label="good")
    assert _ids(server) == ["good"]


def test_server_rejection_does_not_block_later_adds(server):
    view = make(server)
    with pytest.raises(RuntimeError, match="rejected"):
        view.add(Point3D(0, 0), label=5)
    view.add(Point3D(1, 0), label="good")
    assert _ids(server) == ["good"]


def test_offline_removal_is_replayed_and_scene_resent_after_restart(tmp_path):
    first = Server(tmp_path, port=0).start()
    view = Viewer(url=first.url, open_browser=False, spawn=False)
    handle_a = view.add(Point3D(0, 0), label="a")
    view.add(Point3D(1, 0), label="b")
    first.stop()
    with pytest.warns(RuntimeWarning, match="unreachable"):
        handle_a.remove()
    second = Server(tmp_path, port=first.port).start()
    try:
        view.add(Point3D(2, 0), label="c")
        assert _ids(second) == ["b", "c"]
    finally:
        second.stop()


def test_offline_clear_is_replayed_after_reconnect(tmp_path):
    first = Server(tmp_path, port=0).start()
    view = Viewer(url=first.url, open_browser=False, keep=True, spawn=False)
    view.add(Point3D(0, 0), label="a")
    first.stop()
    with pytest.warns(RuntimeWarning, match="unreachable"):
        view.clear()
    second = Server(tmp_path, port=first.port).start()
    try:
        second.state.post({"objects": [{"id": "ghost", "geom": {"type": "point", "p": [0, 0, 0]}}]})
        view.add(Point3D(1, 0), label="b")
        assert _ids(second) == ["b"]
    finally:
        second.stop()


def test_bad_update_leaves_viewer_usable(server):
    view = make(server)
    handle = view.add(Point3D(0, 0), label="a")
    with pytest.raises(ValueError, match="a: .*NaN"):
        handle.update(opacity=math.nan)
    with pytest.raises(TypeError, match="a:"):
        handle.update(width=object())
    view.add(Point3D(1, 0), label="b")
    objs = {o["id"]: o for o in _scene(server)["objects"]}
    assert list(objs) == ["a", "b"]
    assert objs["a"]["style"] == {"color": PALETTE[0]}
    assert view.objects["a"]["style"] == {"color": PALETTE[0]}


def test_url_defaults_to_the_environment_variable(monkeypatch):
    monkeypatch.setenv("GEOMCORE_VIEWER_URL", "http://127.0.0.1:8799/")
    view = Viewer(open_browser=False, spawn=False)
    assert view.url == "http://127.0.0.1:8799"


def test_explicit_url_overrides_the_environment_variable(monkeypatch):
    monkeypatch.setenv("GEOMCORE_VIEWER_URL", "http://127.0.0.1:8799")
    view = Viewer(url="http://127.0.0.1:8123", open_browser=False, spawn=False)
    assert view.url == "http://127.0.0.1:8123"


@pytest.mark.parametrize("value", [None, "", "   "])
def test_unset_or_empty_environment_variable_falls_back_to_the_default(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("GEOMCORE_VIEWER_URL", raising=False)
    else:
        monkeypatch.setenv("GEOMCORE_VIEWER_URL", value)
    assert Viewer(open_browser=False, spawn=False).url == "http://127.0.0.1:8765"


def test_module_level_default_viewer_reads_the_variable_when_created(monkeypatch):
    monkeypatch.setattr(sys.modules["geomcore_viewer.viewer"], "_default", None)
    monkeypatch.setenv("GEOMCORE_VIEWER_URL", "http://127.0.0.1:8799")
    assert gv.viewer().url == "http://127.0.0.1:8799"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_dead_server_is_respawned_on_the_next_add():
    from geomcore_viewer.spawn import stop_server

    url = f"http://127.0.0.1:{_free_port()}"
    view = Viewer(url=url, open_browser=False)
    try:
        view.add(Point3D(0, 0), label="a")
        assert stop_server(url)
        with pytest.warns(RuntimeWarning, match="unreachable"):
            view.add(Point3D(1, 0), label="b")
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            view.add(Point3D(2, 0), label="c")
        with urllib.request.urlopen(f"{url}/api/scene", timeout=5) as res:
            assert [o["id"] for o in json.loads(res.read())["objects"]] == ["a", "b", "c"]
    finally:
        stop_server(url)


def test_browser_opens_only_on_the_first_connect(monkeypatch):
    from geomcore_viewer.spawn import stop_server

    opened = []
    monkeypatch.setattr("webbrowser.open", opened.append)
    url = f"http://127.0.0.1:{_free_port()}"
    view = Viewer(url=url)
    try:
        view.add(Point3D(0, 0), label="a")
        assert opened == [url]
        assert stop_server(url)
        with pytest.warns(RuntimeWarning, match="unreachable"):
            view.add(Point3D(1, 0), label="b")
        view.add(Point3D(2, 0), label="c")
        assert opened == [url]
    finally:
        stop_server(url)


def test_a_later_outage_warns_again(tmp_path):
    first = Server(tmp_path, port=0).start()
    view = Viewer(url=first.url, open_browser=False, spawn=False)
    view.add(Point3D(0, 0), label="a")
    first.stop()
    with pytest.warns(RuntimeWarning, match="unreachable"):
        view.add(Point3D(1, 0), label="b")
    second = Server(tmp_path, port=first.port).start()
    try:
        view.add(Point3D(2, 0), label="c")
        assert _ids(second) == ["a", "b", "c"]
    finally:
        second.stop()
    with pytest.warns(RuntimeWarning, match="unreachable"):
        view.add(Point3D(3, 0), label="d")


def _contrast(a, b):
    def lum(hex_color):
        def channel(c):
            s = int(c, 16) / 255
            return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

        r, g, b_ = (channel(hex_color[i:i + 2]) for i in (1, 3, 5))
        return 0.2126 * r + 0.7152 * g + 0.0722 * b_

    hi, lo = sorted((lum(a), lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


@pytest.mark.parametrize("background", ["#f7f8fa", "#16181d"])
def test_palette_reads_on_both_themes(background):
    assert len(set(PALETTE)) == 8
    for color in PALETTE:
        assert _contrast(color, background) >= 3.0, color


def test_the_rust_client_uses_the_same_palette():
    rust = (Path(__file__).resolve().parents[2] / "clients/rust/src/object.rs").read_text()
    line = next(row for row in rust.splitlines() if row.startswith("pub const PALETTE"))
    assert re.findall(r'"(#[0-9a-f]{6})"', line) == list(PALETTE)


def test_many_arguments_with_several_points_keep_distinct_labels(server):
    two = ("points", [(0.1, Point3D(0, 0), 0.2), (0.3, Point3D(1, 1), 0.4)])
    one = ("point", (0.5, Point3D(2, 2), 0.6))
    handles = make(server).add(two, *[one] * 10, label="P")
    ids = [h.id for h in handles]
    assert ids[:3] == ["P₁,₁", "P₁,₂", "P₂"]
    assert ids[-1] == "P₁₁"
    assert len(set(ids)) == 12


def test_meta_reaches_the_server(server):
    make(server).add(("points", [(0.1, Point3D(1, 0), 0.2)]), label="P")
    [obj] = _scene(server)["objects"]
    assert obj["meta"] == {"tag": "points", "params": [0.1, 0.2]}


def test_pcurve_lies_on_a_surface_already_added(server):
    view = make(server)
    plane = view.add(Plane(), label="pl", u=(0, 4), v=(0, 2))
    on_handle = view.pcurve([(0, 0), (4, 2)], on=plane, label="diag", dashed=True)
    view.pcurve([(1, 0), (1, 2)], on="pl", label="mid")
    objects = {o["id"]: o for o in _scene(server)["objects"]}
    assert on_handle.id == "diag"
    assert objects["diag"]["geom"] == {
        "type": "pcurve", "surface": "pl", "curve": {"type": "polyline", "points": [[0.0, 0.0, 0.0], [4.0, 2.0, 0.0]]},
    }
    assert objects["diag"]["style"] == {"color": PALETTE[1], "dashed": True}
    assert objects["mid"]["geom"]["surface"] == "pl"


def test_pcurve_needs_a_surface_in_the_scene(server):
    view = make(server)
    point = view.add(Point3D(0, 0), label="A")
    with pytest.raises(ValueError, match="'A' is not a surface"):
        view.pcurve([(0, 0), (1, 1)], on=point)
    with pytest.raises(ValueError, match="'nope' is not a surface"):
        view.pcurve([(0, 0), (1, 1)], on="nope")
    assert _ids(server) == ["A"]


def test_u_window_narrows_a_revolution_whose_profile_is_bounded(server):
    """The revolution's bounded profile already sets a v window; u= must still apply."""
    geomcore = pytest.importorskip("geomcore")
    if not hasattr(geomcore, "Axis") or not hasattr(geomcore.surfaces, "RevolutionSurface"):
        pytest.skip("needs geomcore >= 0.43")
    from geomcore import Axis, Point, Vector
    from geomcore.curves import Circle
    from geomcore.surfaces import RevolutionSurface

    view = make(server)
    surface = RevolutionSurface(Circle(Point(3, 0, 0), Vector(0, 1, 0), 1.0), Axis(Point(0, 0, 0), Vector(0, 0, 1)))
    view.add(surface, label="R", u=(0.0, math.pi))
    assert view.objects["R"]["geom"]["window"] == {"u": [0.0, math.pi], "v": [0.0, 2 * math.pi]}


def test_numpy_arrays_are_points_and_point_lists(server):
    np = pytest.importorskip("numpy")
    view = make(server)
    view.polyline(np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0]]), label="A")
    assert view.objects["A"]["geom"]["points"] == [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0]]
    assert len(view.polyline(np.zeros((2, 3, 3)), label="B")) == 2  # a stack of polylines
    assert len(view.arrow(np.zeros((4, 3)), (0, 0, 1), label="C")) == 4
    view.arrow(np.array([1.0, 2.0, 3.0]), np.array([0.0, 0.0, 1.0]), label="D")  # one numpy point
    assert view.objects["D"]["geom"]["at"] == [1.0, 2.0, 3.0]
    texts = view.text([(0, 0), (1, 1)], np.array(["a", "b"]), label="T")
    assert [view.objects[h.id]["geom"]["text"] for h in texts] == ["a", "b"]


def test_points_reject_an_unknown_colormap_and_an_empty_cloud(server):
    view = make(server)
    with pytest.raises(ValueError, match="unknown colormap 'nope'"):
        view.points([(0, 0, 0)], values=[1.0], colormap="nope")
    with pytest.raises(ValueError, match="unknown colormap"):
        view.mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [0, 1, 2], values=[0, 1, 2], colormap="jet")
    with pytest.raises(ValueError, match="empty"):
        view.points([])
    assert view.points([(0, 0, 0)], values=[1.0], colormap="coolwarm", label="P") is not None
    assert view.objects["P"]["geom"]["colormap"] == "coolwarm"


def test_python_colormaps_match_the_page():
    from geomcore_viewer.viewer import COLORMAPS

    source = (Path(__file__).resolve().parents[2] / "frontend/src/ui/colormap.ts").read_text()
    maps = re.search(r"const MAPS[^{]*\{(.*?)\n\};", source, re.S).group(1)
    assert tuple(re.findall(r"^  ([a-z]+):", maps, re.M)) == COLORMAPS
