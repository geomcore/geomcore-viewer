import json
import runpy
import sys
from pathlib import Path

import pytest

EXAMPLES = sorted((Path(__file__).resolve().parents[2] / "examples").glob("*.py"))


@pytest.mark.filterwarnings("ignore:no geomcore-viewer")
@pytest.mark.parametrize("example", EXAMPLES, ids=lambda path: path.name)
def test_example_builds_its_scene_headless(example, tmp_path, monkeypatch):
    geomcore = pytest.importorskip("geomcore")
    if not hasattr(geomcore, "CurveCurveIntersection"):
        pytest.skip("the examples need geomcore >= 0.36")
    saved = tmp_path / "scene.json"
    monkeypatch.setattr(sys, "argv", [str(example), "--save", str(saved)])
    runpy.run_path(str(example), run_name="__main__")
    assert json.loads(saved.read_text())["objects"]
