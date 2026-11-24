# Get started

## Python

Install the viewer in your project's virtual environment. Version 0.6.0 supports geomcore 0.44 through 0.47.

```sh
python -m pip install geomcore-viewer
```

Save this as `circle.py` and run `python circle.py`.

```python
from geomcore import Circle, Point, Vector
from geomcore_viewer import Viewer

view = Viewer("Circle", view="2d")
view.add(Circle(Point.origin(), Vector.unit_z(), 2.0), label="Circle")
```

The first `add` starts the local server and opens a browser tab. Drag to pan and scroll to zoom. Hover the circle to read its parameter and coordinates. Run the script again to update the scene in the same tab.

Set `view="3d"` for a spatial scene. The default `view="auto"` selects the plane view when the scene lies in `z = 0`.

## Rust

In a Cargo project, add the client and geomcore. The client's optional `geomcore` feature supports geomcore 0.48.

```toml
[dependencies]
geomcore = "0.48"
geomcore-viewer = { version = "0.6", features = ["geomcore"] }
```

In a separate terminal, install the Python package and run `geomcore-viewer serve`. Then save this as `src/main.rs` and run `cargo run`.

```rust
use geomcore::{Circle, Point, Vector};
use geomcore_viewer::{Opts, Viewer};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut view = Viewer::new("Circle")?;
    let circle = Circle::new(Point::ORIGIN, Vector::Z, 2.0)?;
    view.add(&circle, Opts::new().label("Circle"))?;
    Ok(())
}
```

The client sends the geometry to the local server. If the server is unavailable, the client keeps the scene in memory and you can still save it to JSON.
