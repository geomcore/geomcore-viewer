"""Curves given in a surface's (u, v) parameters — drawn on the surface and in the (u,v) pane.

Run:   python examples/pcurve.py            (press U in the 3D view to toggle the (u,v) pane)
Save:  python examples/pcurve.py --save frontend/e2e/scenes/pcurve.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py).
"""

from __future__ import annotations

import argparse
import math

from geomcore import Point2D, Point3D, Vector2D, Vector3D
from geomcore.curves import Circle3D, Line2D
from geomcore.surfaces import Cylinder

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("Curves on a cylinder", spawn=args.save is None)

Y = Cylinder(Point3D.origin(), Vector3D.unit_z(), 2.0)
cyl = view.add(Y, label="Y", v=(-1.0, 4.0))

# A circle of the cylinder, handed over as its (u, v) image: the line v = 1.5.
ring = Circle3D(Point3D(0.0, 0.0, 1.5), Vector3D.unit_z(), 2.0)
view.pcurve(ring.parametrize_on(Y), on=cyl, label="ring")

# A helix: the line v = u / 4 in (u, v). Unbounded, it is drawn where it crosses the window v ∈ [-1, 4].
view.pcurve(Line2D(Point2D(0.0, 0.0), Vector2D(1.0, 0.25)), on=cyl, label="helix")

# A hand-made (u, v) polyline: a zig-zag around the lower part.
zigzag = [(k * math.pi / 4, 0.0 if k % 2 == 0 else -0.8) for k in range(9)]
view.pcurve(zigzag, on=cyl, label="zigzag", dashed=True)

if args.save:
    print(f"saved {view.save(args.save)}")
