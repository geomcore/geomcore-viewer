//! Exact B-spline curves and surfaces — sent native, evaluated in the page.
//!
//! Run:   python -m geomcore_viewer serve &   (once)
//!        cargo run --example bspline --features geomcore
//! Save:  cargo run --example bspline --features geomcore -- --save bspline.json

use geomcore::{BSplineCurve3D, BSplineSurface, Bound3D, Point3D, TrimmedCurve3D, Vector3D};
use geomcore_viewer::{Opts, ViewMode, Viewer};

fn p(x: f64, y: f64, z: f64) -> Point3D {
    Point3D::new(x, y, z)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let save = std::env::args().skip_while(|a| a != "--save").nth(1);
    let mut view = Viewer::builder("Exact B-splines").view(ViewMode::Space).build()?;

    let curve = BSplineCurve3D::new(
        3,
        vec![p(0.0, 0.0, 0.0), p(1.0, 2.0, 0.0), p(3.0, 2.0, 1.0), p(4.0, 0.0, 0.0)],
        vec![0.0, 1.0],
        vec![4, 4],
        false,
    )?;
    view.add(&curve, Opts::new().label("spline"))?;
    let piece = TrimmedCurve3D::new(curve, 0.25, 0.75)?;
    view.add(&piece, Opts::new().label("piece"))?;
    view.add(&piece.bounding_box().unwrap(), Opts::new().label("box"))?;

    let patch = BSplineSurface::new(
        1,
        1,
        vec![vec![p(0.0, 0.0, 0.0), p(0.0, 2.0, 0.0)], vec![p(2.0, 0.0, 0.0), p(2.0, 2.0, 1.0)]],
        vec![0.0, 1.0],
        vec![2, 2],
        vec![0.0, 1.0],
        vec![2, 2],
        false,
        false,
    )?;
    let ps = view.add(&patch, Opts::new().label("patch"))?;
    view.pcurve(
        geomcore_viewer::Geom::polyline(vec![[0.0, 0.0, 0.0], [1.0, 1.0, 0.0]]),
        &ps,
        Opts::new().label("diag"),
    )?;

    // A circle as a periodic rational B-spline, exactly.
    let ring = geomcore::Circle3D::new(p(0.0, 0.0, 3.0), Vector3D::Z, 2.0)?.to_bspline();
    view.add(&ring, Opts::new().label("ring"))?;

    if let Some(path) = save {
        println!("saved {}", view.save(path)?.display());
    }
    Ok(())
}
