"""Conics and where they meet — the classroom demo.

Run:   python examples/conics_2d.py            (re-run after every edit; the tab updates in place)
Save:  python examples/conics_2d.py --save frontend/public/sample-scene.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py); the examples use
the current class names, geomcore 0.44 or later.
"""

from __future__ import annotations

import argparse

from geomcore import Circle, Ellipse, Frame, Hyperbola, Line, Parabola, Point, Vector

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("Conics and their intersections", spawn=args.save is None)

E = Ellipse.from_frame(Frame.world(), 3.0, 2.0)
C = Circle(Point(2.0, 1.0, 0.0), Vector.unit_z(), 1.5)
H = Hyperbola.from_frame(Frame.world(), 1.0, 0.5)
A = Parabola(Point(-1.3, -1.4, 0.0), Vector.unit_z(), Vector(0.0, 1.0, 0.0), 0.45)
L = Line(Point(0.0, -3.0, 0.0), Vector(1.0, 1.0, 0.0))

view.add(E, label="E", group="conics", foci=True)
view.add(C, label="C", group="conics")
view.add(H, label="H", group="conics", asymptotes=True)
view.add(A, label="A", group="conics")
view.add(L, label="L", group="conics")

def show_hits(first, second, label):
    result = first.intersect(second)
    # Keep both curve parameters in the tooltip and leave result notes out of this demo.
    hits = [(hit.first_parameter, hit.point, hit.second_parameter) for hit in result.hits]
    view.add(("points", hits), label=label, group="intersections")


show_hits(C, E, "P")
show_hits(L, E, "Q")
show_hits(L, C, "R")
show_hits(L, H, "S")
show_hits(C, H, "T")
show_hits(E, H, "U")

if args.save:
    print(f"saved {view.save(args.save)}")
