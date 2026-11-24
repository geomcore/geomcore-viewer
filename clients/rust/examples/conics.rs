//! Conics and where they meet — the Rust twin of `examples/conics_2d.py`.
//!
//! Run:   python -m geomcore_viewer serve &   (once; any Python viewer script also starts it)
//!        cargo run --example conics --features geomcore
//! Save:  cargo run --example conics --features geomcore -- --save conics.json

use geomcore::Curve;
use geomcore::{
    Circle, CurveCurveIntersection, Ellipse, Frame, Hyperbola, Intersect, Line, Parabola, Point, Tolerance, Vector,
};
use geomcore_viewer::{Opts, Viewer};

/// Where two curves meet, through geomcore's one entry point for exact intersections.
fn meet(a: impl Into<Curve>, b: impl Into<Curve>) -> Vec<Point> {
    let result: CurveCurveIntersection = a.into().intersect(&b.into(), Tolerance::DEFAULT);
    result.hits().iter().map(|hit| hit.point).collect()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let save = std::env::args().skip_while(|a| a != "--save").nth(1);
    let mut view = Viewer::new("Conics and their intersections")?;

    let e = Ellipse::from_frame(Frame::WORLD, 3.0, 2.0)?;
    let c = Circle::new(Point::new(2.0, 1.0, 0.0), Vector::Z, 1.5)?;
    let h = Hyperbola::from_frame(Frame::WORLD, 1.0, 0.5)?;
    let a = Parabola::new(Point::new(-1.3, -1.4, 0.0), Vector::Z, Vector::Y, 0.45)?;
    let l = Line::new(Point::new(0.0, -3.0, 0.0), Vector::new(1.0, 1.0, 0.0))?;

    let conics = || Opts::new().group("conics");
    view.add(&e, conics().label("E").extra("foci", true))?;
    view.add(&c, conics().label("C"))?;
    view.add(&h, conics().label("H").extra("asymptotes", true))?;
    view.add(&a, conics().label("A"))?;
    view.add(&l, conics().label("L"))?;

    let points = |label: &str| Opts::new().label(label).group("intersections");
    view.add_all(meet(c, e), points("P"))?;
    view.add_all(meet(l, e), points("Q"))?;
    view.add_all(meet(l, c), points("R"))?;
    view.add_all(meet(l, h), points("S"))?;
    view.add_all(meet(c, h), points("T"))?;
    view.add_all(meet(e, h), points("U"))?;

    if let Some(path) = save {
        println!("saved {}", view.save(path)?.display());
    }
    Ok(())
}
