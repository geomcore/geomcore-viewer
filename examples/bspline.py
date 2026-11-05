"""Exact B-spline curves and surfaces — sent native, evaluated in the page.

Run:   python examples/bspline.py             (press U in the 3D view to toggle the (u,v) pane)
Save:  python examples/bspline.py --save frontend/e2e/scenes/bspline.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py).
"""

from __future__ import annotations

import argparse
import math

from geomcore import Point, Vector
from geomcore.curves import BSplineCurve, Circle, TrimmedCurve
from geomcore.surfaces import BSplineSurface

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("Exact B-splines", spawn=args.save is None)

# A clamped cubic, whole and as a trimmed piece (both stay exact).
poles = [Point(0, 0, 0), Point(1, 2, 0), Point(3, 2, 1), Point(4, 0, 0)]
curve = BSplineCurve(3, poles, [0.0, 1.0], [4, 4], False)
view.add(curve, label="spline")
view.add(TrimmedCurve(curve, 0.25, 0.75), label="piece", color="#00798c")

# A periodic rational B-spline: a circle, exactly.
ring = Circle(Point(0, 0, 3), Vector(0, 0, 1), 2.0).to_bspline()
view.add(ring, label="ring")

# A bilinear patch, with a diagonal drawn on it in (u, v).
patch = BSplineSurface(1, 1, [[Point(0, 0, 0), Point(0, 2, 0)], [Point(2, 0, 0), Point(2, 2, 1)]],
                       [0.0, 1.0], [2, 2], [0.0, 1.0], [2, 2], False, False)
ps = view.add(patch, label="patch")
view.pcurve([(0, 0), (1, 1)], on=ps, label="diag")

# The trimmed piece's bounding box, beside it.
view.add(TrimmedCurve(curve, 0.25, 0.75).bounding_box(), label="box")

if args.save:
    print(f"saved {view.save(args.save)}")
