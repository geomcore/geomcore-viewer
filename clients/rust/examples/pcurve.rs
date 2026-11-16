//! A circle on a cylinder and its image in the cylinder's (u, v) parameter space.
//!
//! Run:   python -m geomcore_viewer serve &   (once)
//!        cargo run --example pcurve --features geomcore
//! Save:  cargo run --example pcurve --features geomcore -- --save pcurve.json

use geomcore::{Circle, Curve, Cylinder, ParametricSurface, Point, Tolerance, Vector};
use geomcore_viewer::{Opts, ViewMode, Viewer};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let save = std::env::args().skip_while(|a| a != "--save").nth(1);
    let mut view = Viewer::builder("A circle on a cylinder").view(ViewMode::Space).build()?;

    let cylinder = Cylinder::new(Point::ORIGIN, Vector::Z, 2.0)?;
    let ring = Circle::new(Point::new(0.0, 0.0, 1.0), Vector::Z, 2.0)?;

    let s = view.add(
        geomcore_viewer::Geom::from(&cylinder).window(None, Some([-2.0, 2.0])),
        Opts::new().label("S").opacity(0.5),
    )?;
    view.add(&ring, Opts::new().label("C"))?;
    // curve_3d_to_uv gives the circle's exact image in (u, v): here the line v = 1.
    view.pcurve(
        &cylinder.curve_3d_to_uv(&Curve::from(ring), Tolerance::DEFAULT)?,
        &s,
        Opts::new().label("C in (u, v)"),
    )?;

    if let Some(path) = save {
        println!("saved {}", view.save(path)?.display());
    }
    Ok(())
}
