//! Conics and where they meet — the Rust twin of `examples/conics_2d.py`.
//!
//! Run:   python -m geomcore_viewer serve &   (once; any Python viewer script also starts it)
//!        cargo run --example conics --features geomcore
//! Save:  cargo run --example conics --features geomcore -- --save conics.json

use geomcore::curves::Curve3D;
use geomcore::{
    Circle3D, CurveCurveIntersection, Ellipse3D, Frame3D, Hyperbola3D, Intersect, Line3D, Point3D, Tolerance, Vector3D,
};
use geomcore_viewer::{Opts, Viewer};

/// Where two curves meet, through geomcore's one entry point for exact intersections.
fn meet(a: impl Into<Curve3D>, b: impl Into<Curve3D>) -> Vec<Point3D> {
    let result: CurveCurveIntersection = a.into().intersect(&b.into(), Tolerance::DEFAULT);
    result.hits().iter().map(|hit| hit.point).collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let save = std::env::args().skip_while(|a| a != "--save").nth(1);
    let mut view = Viewer::new("Conics and their intersections")?;

    let e = Ellipse3D::from_frame(Frame3D::WORLD, 3.0, 2.0)?;
    let c = Circle3D::new(Point3D::new(2.0, 1.0, 0.0), Vector3D::Z, 1.5)?;
    let h = Hyperbola3D::from_frame(Frame3D::WORLD, 1.0, 0.5)?;
    let l = Line3D::new(Point3D::new(0.0, -3.0, 0.0), Vector3D::new(1.0, 1.0, 0.0))?;

    let conics = || Opts::new().group("conics");
    view.add(&e, conics().label("E").extra("foci", true))?;
    view.add(&c, conics().label("C"))?;
    view.add(&h, conics().label("H").extra("asymptotes", true))?;
    view.add(&l, conics().label("L"))?;

    let points = |label: &str| Opts::new().label(label).group("intersections");
    view.add_all(meet(c, e), points("P"))?;
    view.add_all(meet(l, e), points("Q"))?;
    view.add_all(meet(l, c), points("R"))?;
    view.add_all(meet(l, h), points("S"))?;

    if let Some(path) = save {
        println!("saved {}", view.save(path)?.display());
    }
    Ok(())
}
