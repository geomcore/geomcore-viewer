import json
import runpy
import sys
from importlib.metadata import version
from pathlib import Path

import pytest

EXAMPLES = sorted((Path(__file__).resolve().parents[2] / "examples").glob("*.py"))


@pytest.mark.filterwarnings("ignore:no geomcore-viewer")
@pytest.mark.parametrize("example", EXAMPLES, ids=lambda path: path.name)
def test_example_builds_its_scene_headless(example, tmp_path, monkeypatch):
    pytest.importorskip("geomcore")
    # Skip on the version, not on a missing name: a future rename must fail here, not skip.
    if tuple(int(part) for part in version("geomcore").split(".")[:2]) < (0, 39):
        pytest.skip("the examples use the current class names: geomcore >= 0.39")
    saved = tmp_path / "scene.json"
    monkeypatch.setattr(sys, "argv", [str(example), "--save", str(saved)])
    runpy.run_path(str(example), run_name="__main__")
    assert json.loads(saved.read_text())["objects"]
