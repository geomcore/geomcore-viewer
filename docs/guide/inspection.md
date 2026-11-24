# Inspect geometry

## Navigate the scene

In 2D, drag to pan. In 3D, drag to orbit and right-drag to pan. The 3D toolbar switches between perspective and orthographic projection and provides top, front, right, and isometric views. Scroll to zoom in either view.

Click an object in the object list to frame it. Use the checkboxes to hide objects or groups. In narrow embeds, open the list with **Objects**.

| Key | Action |
| --- | --- |
| `F` | Fit the scene and resume following updates |
| `P` | Toggle presentation mode |
| `T` | Switch between light and dark themes |
| `U` | Toggle the UV plot |
| `←` / `→` | Browse lesson steps |
| `Esc` | Close the object list, leave presentation mode, or clear the selection |

## Compare a curve with its parametric image

A pcurve is a curve expressed in a surface's `(u, v)` coordinates. Add the surface first, then pass its handle to `pcurve`. For an infinite surface, supply a parameter window to show the relevant part.

```python
from geomcore import Circle, Cylinder, Point, Vector
from geomcore_viewer import Viewer

view = Viewer("Ring on a cylinder", view="3d")
cylinder = Cylinder(Point.origin(), Vector.unit_z(), 2.0)
surface = view.add(cylinder, label="Cylinder", v=(0.0, 3.0))

ring = Circle(Point(0.0, 0.0, 1.5), Vector.unit_z(), 2.0)
view.pcurve(cylinder.curve_3d_to_uv(ring), on=surface, label="Ring")
```

The UV plot opens beside the 3D scene on a wide screen and below it on a narrow screen. Hover the curve in either pane to locate the corresponding point in the other. In Rust, use `view.pcurve(&uv, &surface, opts)`.

## Inspect query results

In Python, pass projection, intersection, or extrema results directly to `view.add(result)`. The viewer draws the result and fades its inputs. Use `operands=False` to omit the inputs. Intersection notes report the method and, when available, why a result is incomplete. In Rust, extract and add the geometry from the result.

## Show scalar values and compare steps

Use `view.points(xyz, values=scalars, colormap="viridis")` to colour a point cloud by one scalar per point. Supply one value per vertex for a coloured mesh. The Rust client exposes `Geom::points_colored`.

Use `with view.step("tilt 45°"):` in Python or `view.step("tilt 45°")?` in Rust to group geometry into lesson steps. Geometry added outside a step stays visible as you browse with the slider.
