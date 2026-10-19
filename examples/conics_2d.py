"""Conics and where they meet — the classroom demo.

Run:   python examples/conics_2d.py            (re-run after every edit; the tab updates in place)
Save:  python examples/conics_2d.py --save frontend/public/sample-scene.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py).
"""

from __future__ import annotations

import argparse

from geomcore import Frame3D, Point3D, Vector3D
from geomcore.curves import Circle3D, Ellipse3D, Hyperbola3D, Line3D

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("Conics and their intersections", spawn=args.save is None)

E = Ellipse3D.from_frame(Frame3D.world(), 3.0, 2.0)
C = Circle3D(Point3D(2.0, 1.0, 0.0), Vector3D.unit_z(), 1.5)
H = Hyperbola3D.from_frame(Frame3D.world(), 1.0, 0.5)
L = Line3D(Point3D(0.0, -3.0, 0.0), Vector3D(1.0, 1.0, 0.0))

view.add(E, label="E", group="conics", foci=True)
view.add(C, label="C", group="conics")
view.add(H, label="H", group="conics", asymptotes=True)
view.add(L, label="L", group="conics")

view.add(C.intersect(E), label="P", group="intersections")
view.add(L.intersect(E), label="Q", group="intersections")
view.add(L.intersect(C), label="R", group="intersections")
view.add(L.intersect(H), label="S", group="intersections")

if args.save:
    print(f"saved {view.save(args.save)}")
