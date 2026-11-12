"""Lesson steps: one parameter value per step, browsed with the slider (or ←/→).

Each step holds its own plane and intersection; the circle outside the steps is shared. Compare
with adding every tilt at once, which piles the states on top of each other.

Run:   python examples/steps.py
Save:  python examples/steps.py --save frontend/e2e/scenes/steps_example.json
Needs geomcore (pip install geomcore, or PYTHONPATH=../geomcore/geomcore-py).
"""

from __future__ import annotations

import argparse
import math

from geomcore import Circle, Plane, Point, Vector

import geomcore_viewer as gv

parser = argparse.ArgumentParser()
parser.add_argument("--save", help="write the scene to this JSON file instead of opening the viewer")
args = parser.parse_args()

view = gv.Viewer("One tilt per step", spawn=args.save is None)

# Shared by every step: the circle the planes cut.
C = Circle(Point.origin(), Vector.unit_z(), 3.0)
view.add(C, label="C", group="circle")

for degrees in range(0, 91, 15):
    with view.step(f"tilt {degrees}°"):
        rad = math.radians(degrees)
        plane = Plane(Point.origin(), Vector(0.0, -math.sin(rad), math.cos(rad)))
        view.add(plane, label="Π", group="planes", u=(-4.0, 4.0), v=(-4.0, 4.0))
        view.add(plane.intersect(C), label="Π∩C", group="planes", operands=False)

if args.save:
    print(f"saved {view.save(args.save)}")
