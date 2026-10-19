"""Sphere ∩ cylinder and plane ∩ cone — intersection curves in 3D.

Run:   python examples/quadrics_3d.py
Save:  python examples/quadrics_3d.py --save frontend/e2e/scenes/quadrics_3d.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py).
"""

from __future__ import annotations

import argparse

from geomcore import Frame3D, Point3D, Vector3D
from geomcore.surfaces import Cone, Cylinder, Plane, Sphere

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("Quadric intersections", spawn=args.save is None)

S = Sphere(Point3D.origin(), 3.0)
Y = Cylinder(Point3D.origin(), Vector3D.unit_z(), 2.0)
view.add(S, label="S", opacity=0.4, group="sphere ∩ cylinder")
view.add(Y, label="Y", opacity=0.4, v=(-3.5, 3.5), group="sphere ∩ cylinder")
view.add(S.intersect(Y), label="SY", group="sphere ∩ cylinder")

K = Cone.from_frame(Frame3D(Point3D(9.0, 0.0, 0.0), Vector3D.unit_z(), Vector3D.unit_x()), 0.4, 2.0)
P = Plane(Point3D(9.0, 0.0, 1.0), Vector3D.unit_z())
view.add(K, label="K", opacity=0.4, v=(-4.0, 4.0), group="plane ∩ cone")
view.add(P, label="Π", opacity=0.3, u=(-4.0, 4.0), v=(-4.0, 4.0), group="plane ∩ cone")
view.add(P.intersect(K), label="ΠK", group="plane ∩ cone")

if args.save:
    print(f"saved {view.save(args.save)}")
