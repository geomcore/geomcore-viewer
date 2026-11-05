//! geomcore types as [`Geom`] (cargo feature `geomcore`).
//!
//! Analytic curves and surfaces keep their exact definition: the frame and radii
//! come from geomcore's getters, so the viewer evaluates the same parametrization
//! (checked against `eval_point` in the tests). `TrimmedCurve3D`/`TrimmedCurve2D`
//! keep their basis with a parameter range, and B-splines go exact (degree,
//! poles, weights, knots, multiplicities, periodicity). Only a geometry the
//! protocol has no wire type for is sampled: a future `Curve3D`/`Surface`
//! variant as a 256-segment polyline / 48 × 48 mesh over its parameter bounds.

use geomcore::curves::{ParametricCurve2D, ParametricCurve3D};
use geomcore::surfaces::ParametricSurface;
use geomcore::{
    BSplineCurve3D, BSplineSurface, BoundingBox3D, Circle2D, Circle3D, Cone, Curve2D, Curve3D, Cylinder,
    ElementaryCurve, ElementarySurface, Ellipse3D, Frame3D, Hyperbola3D, Line2D, Line3D, Parabola3D, Plane, Point2D,
    Point3D, Sphere, Surface, Torus, TrimmedCurve2D, TrimmedCurve3D, Vector3D,
};

use crate::geom::{cross, Frame, Geom, Vec3};

const BSPLINE_SEGMENTS: usize = 256;
const BSPLINE_GRID: usize = 48;
/// Where a curve or surface of a kind added to geomcore later is sampled when a parameter bound is infinite.
const UNBOUNDED: f64 = 100.0;

/// A parameter bound as-is when finite, else clamped to ±[`UNBOUNDED`].
fn bound(b: f64, sign: f64) -> f64 {
    if b.is_finite() {
        b
    } else {
        sign * UNBOUNDED
    }
}

fn sample(eval: impl Fn(f64) -> Vec3, (t0, t1): (f64, f64)) -> Geom {
    let (t0, t1) = (bound(t0, -1.0), bound(t1, 1.0));
    Geom::polyline((0..=BSPLINE_SEGMENTS).map(|i| eval(t0 + (t1 - t0) * i as f64 / BSPLINE_SEGMENTS as f64)).collect())
}

fn p3(p: Point3D) -> Vec3 {
    [p.x, p.y, p.z]
}

fn v3(v: Vector3D) -> Vec3 {
    [v.x, v.y, v.z]
}

fn frame(f: Frame3D) -> Frame {
    Frame { o: p3(f.origin()), x: v3(f.x_direction()), y: v3(f.y_direction()), z: v3(f.z_direction()) }
}

/// An (n + 1)² vertex grid, two triangles per cell.
fn grid(eval: impl Fn(f64, f64) -> Vec3, (u0, u1): (f64, f64), (v0, v1): (f64, f64)) -> Geom {
    let n = BSPLINE_GRID;
    let (u0, u1, v0, v1) = (bound(u0, -1.0), bound(u1, 1.0), bound(v0, -1.0), bound(v1, 1.0));
    let mut vertices = Vec::with_capacity((n + 1) * (n + 1));
    for i in 0..=n {
        for j in 0..=n {
            vertices.push(eval(u0 + (u1 - u0) * i as f64 / n as f64, v0 + (v1 - v0) * j as f64 / n as f64));
        }
    }
    let mut indices = Vec::with_capacity(6 * n * n);
    for i in 0..n {
        for j in 0..n {
            let a = (i * (n + 1) + j) as u32;
            let b = a + (n + 1) as u32;
            indices.extend([a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    Geom::mesh(vertices, indices)
}

impl From<Point3D> for Geom {
    fn from(p: Point3D) -> Geom {
        Geom::point(p3(p))
    }
}

impl From<Point2D> for Geom {
    fn from(p: Point2D) -> Geom {
        Geom::point([p.x, p.y, 0.0])
    }
}

impl From<&Line3D> for Geom {
    fn from(c: &Line3D) -> Geom {
        Geom::line(p3(c.origin()), v3(c.direction()))
    }
}

/// True when `size` is nothing next to where it sits: the radius-zero circle or the B-spline with
/// coinciding poles that `u_iso`/`v_iso` give at an apex, a pole or a pinch, sent as a point
/// (radii on the wire must be positive).
fn collapsed(size: f64, at: Vec3) -> bool {
    size <= 1e-12 * at.iter().map(|x| x * x).sum::<f64>().sqrt().max(1.0)
}

impl From<&Circle3D> for Geom {
    fn from(c: &Circle3D) -> Geom {
        let center = p3(c.center());
        if collapsed(c.radius().abs(), center) {
            return Geom::point(center);
        }
        Geom::circle(frame(c.frame()), c.radius())
    }
}

impl From<&Ellipse3D> for Geom {
    fn from(c: &Ellipse3D) -> Geom {
        Geom::ellipse(frame(c.frame()), c.major_radius(), c.minor_radius())
    }
}

impl From<&Parabola3D> for Geom {
    fn from(c: &Parabola3D) -> Geom {
        Geom::parabola(frame(c.frame()), c.focal())
    }
}

impl From<&Hyperbola3D> for Geom {
    fn from(c: &Hyperbola3D) -> Geom {
        Geom::hyperbola(frame(c.frame()), c.major_radius(), c.minor_radius())
    }
}

impl From<&BSplineCurve3D> for Geom {
    fn from(c: &BSplineCurve3D) -> Geom {
        let first = p3(c.poles()[0]);
        if c.poles().iter().all(|q| collapsed(q.distance(c.poles()[0]), first)) {
            return Geom::point(first);
        }
        bspline_curve(c, None)
    }
}

/// A B-spline curve as its exact definition: degree, poles, weights (when
/// rational), distinct knots with multiplicities, and periodicity. The viewer
/// evaluates the same parametrization (checked against `eval_point` in the
/// tests); `range` limits a trimmed piece to `[first, last]`.
fn bspline_curve(c: &BSplineCurve3D, range: Option<[f64; 2]>) -> Geom {
    Geom::BsplineCurve {
        degree: c.degree(),
        poles: c.poles().iter().map(|p| p3(*p)).collect(),
        weights: c.weights().map(|w| w.to_vec()),
        knots: c.knots().to_vec(),
        multiplicities: c.multiplicities().to_vec(),
        periodic: c.is_periodic(),
        range,
    }
}

impl From<&Curve3D> for Geom {
    fn from(c: &Curve3D) -> Geom {
        match c {
            Curve3D::Line(c) => c.into(),
            Curve3D::Circle(c) => c.into(),
            Curve3D::Ellipse(c) => c.into(),
            Curve3D::Parabola(c) => c.into(),
            Curve3D::Hyperbola(c) => c.into(),
            Curve3D::BSpline(c) => c.into(),
            other => sample(|t| p3(other.eval_point(t)), other.bounds()),
        }
    }
}

impl From<&ElementaryCurve> for Geom {
    fn from(c: &ElementaryCurve) -> Geom {
        Geom::from(&Curve3D::from(*c))
    }
}

/// A piece of a 3D curve: an analytic basis keeps its exact definition with a
/// parameter `range`; a B-spline piece (or anything else) is sampled over the
/// trimmed range only.
macro_rules! trimmed3d_exact {
    ($($basis:ty),*) => { $( impl From<&TrimmedCurve3D<$basis>> for Geom {
        fn from(t: &TrimmedCurve3D<$basis>) -> Geom {
            Geom::from(t.basis()).range(t.first(), t.last())
        }
    } )* };
}
trimmed3d_exact!(Line3D, Circle3D, Ellipse3D, Parabola3D, Hyperbola3D);

impl From<&TrimmedCurve3D<BSplineCurve3D>> for Geom {
    fn from(t: &TrimmedCurve3D<BSplineCurve3D>) -> Geom {
        bspline_curve(t.basis(), Some([t.first(), t.last()]))
    }
}

impl From<&TrimmedCurve3D<Curve3D>> for Geom {
    fn from(t: &TrimmedCurve3D<Curve3D>) -> Geom {
        if let Curve3D::BSpline(c) = t.basis() {
            return bspline_curve(c, Some([t.first(), t.last()]));
        }
        match Geom::from(t.basis()) {
            analytic @ (Geom::Line { .. }
            | Geom::Circle { .. }
            | Geom::Ellipse { .. }
            | Geom::Parabola { .. }
            | Geom::Hyperbola { .. }) => analytic.range(t.first(), t.last()),
            _ => sample(|u| p3(t.eval_point(u)), (t.first(), t.last())),
        }
    }
}

/// A 2D line in z = 0 — as a pcurve, its x, y are the surface's u, v.
impl From<&Line2D> for Geom {
    fn from(c: &Line2D) -> Geom {
        let (o, d) = (c.origin(), c.direction());
        Geom::line([o.x, o.y, 0.0], [d.x, d.y, 0.0])
    }
}

/// A 2D circle in z = 0, with its own frame (either handedness: z is x × y).
impl From<&Circle2D> for Geom {
    fn from(c: &Circle2D) -> Geom {
        let f = c.frame();
        let (o, x, y) = (f.origin(), f.x_direction(), f.y_direction());
        let (x, y) = ([x.x, x.y, 0.0], [y.x, y.y, 0.0]);
        Geom::circle(Frame { o: [o.x, o.y, 0.0], x, y, z: cross(x, y) }, c.radius())
    }
}

impl From<&Curve2D> for Geom {
    fn from(c: &Curve2D) -> Geom {
        match c {
            Curve2D::Line(c) => c.into(),
            Curve2D::Circle(c) => c.into(),
            other => sample(
                |t| {
                    let p = other.eval_point(t);
                    [p.x, p.y, 0.0]
                },
                other.bounds(),
            ),
        }
    }
}

/// A piece of a 2D curve in z = 0 (as a pcurve, its x, y are the surface's u, v):
/// like its 3D sibling, analytic stays exact with a `range`, the rest is sampled
/// over the trimmed range.
impl From<&TrimmedCurve2D<Line2D>> for Geom {
    fn from(t: &TrimmedCurve2D<Line2D>) -> Geom {
        Geom::from(t.basis()).range(t.first(), t.last())
    }
}

impl From<&TrimmedCurve2D<Circle2D>> for Geom {
    fn from(t: &TrimmedCurve2D<Circle2D>) -> Geom {
        Geom::from(t.basis()).range(t.first(), t.last())
    }
}

impl From<&TrimmedCurve2D<Curve2D>> for Geom {
    fn from(t: &TrimmedCurve2D<Curve2D>) -> Geom {
        match Geom::from(t.basis()) {
            analytic @ (Geom::Line { .. } | Geom::Circle { .. }) => analytic.range(t.first(), t.last()),
            _ => sample(
                |u| {
                    let p = t.eval_point(u);
                    [p.x, p.y, 0.0]
                },
                (t.first(), t.last()),
            ),
        }
    }
}

impl From<&Plane> for Geom {
    fn from(s: &Plane) -> Geom {
        Geom::plane(frame(s.frame()))
    }
}

impl From<&Cylinder> for Geom {
    fn from(s: &Cylinder) -> Geom {
        Geom::cylinder(frame(s.frame()), s.radius())
    }
}

impl From<&Cone> for Geom {
    fn from(s: &Cone) -> Geom {
        Geom::cone(frame(s.frame()), s.semi_angle(), s.ref_radius())
    }
}

impl From<&Sphere> for Geom {
    fn from(s: &Sphere) -> Geom {
        Geom::sphere(frame(s.frame()), s.radius())
    }
}

impl From<&Torus> for Geom {
    fn from(s: &Torus) -> Geom {
        Geom::torus(frame(s.frame()), s.major_radius(), s.minor_radius())
    }
}

/// A mesh over the surface's parameter bounds.
impl From<&BSplineSurface> for Geom {
    fn from(s: &BSplineSurface) -> Geom {
        bspline_surface(s)
    }
}

/// A B-spline surface as its exact definition: degrees, the pole net
/// (`nu` rows of `nv` poles), weights (when rational), distinct knots with
/// multiplicities per direction, and periodicity. The viewer evaluates the
/// same parametrization (checked against `eval_point` in the tests).
fn bspline_surface(s: &BSplineSurface) -> Geom {
    let (u0, u1) = s.u_bounds();
    let (v0, v1) = s.v_bounds();
    Geom::BsplineSurface {
        u_degree: s.u_degree(),
        v_degree: s.v_degree(),
        nu: s.u_pole_count(),
        nv: s.v_pole_count(),
        poles: s.poles().iter().map(|p| p3(*p)).collect(),
        weights: s.weights().map(|w| w.to_vec()),
        u_knots: s.u_knots().to_vec(),
        u_multiplicities: s.u_multiplicities().to_vec(),
        v_knots: s.v_knots().to_vec(),
        v_multiplicities: s.v_multiplicities().to_vec(),
        u_periodic: s.is_u_periodic(),
        v_periodic: s.is_v_periodic(),
        window: crate::geom::Window::default(),
    }
    .window(Some([u0, u1]), Some([v0, v1]))
}

impl From<&Surface> for Geom {
    fn from(s: &Surface) -> Geom {
        match s {
            Surface::Plane(s) => s.into(),
            Surface::Cylinder(s) => s.into(),
            Surface::Cone(s) => s.into(),
            Surface::Sphere(s) => s.into(),
            Surface::Torus(s) => s.into(),
            Surface::BSpline(s) => s.into(),
            other => grid(|u, v| p3(other.eval_point(u, v)), other.u_bounds(), other.v_bounds()),
        }
    }
}

impl From<&ElementarySurface> for Geom {
    fn from(s: &ElementarySurface) -> Geom {
        Geom::from(&Surface::from(*s))
    }
}

impl From<&BoundingBox3D> for Geom {
    fn from(b: &BoundingBox3D) -> Geom {
        Geom::bbox(p3(b.min()), p3(b.max()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use geomcore::{Axis3D, Tolerance, Transform, Vector2D};

    const TOL: f64 = 1e-9;

    /// The protocol's parametrizations (`protocol/SCENE.md`), as the viewer evaluates them.
    fn eval_curve(g: &Geom, t: f64) -> Vec3 {
        let at = |f: &Frame, a: f64, b: f64| -> Vec3 { std::array::from_fn(|k| f.o[k] + a * f.x[k] + b * f.y[k]) };
        match g {
            Geom::Line { o, d, .. } => std::array::from_fn(|k| o[k] + t * d[k]),
            Geom::Circle { frame: f, r, .. } => at(f, r * t.cos(), r * t.sin()),
            Geom::Ellipse { frame: f, a, b, .. } => at(f, a * t.cos(), b * t.sin()),
            Geom::Parabola { frame: f, f: focal, .. } => at(f, t * t / (4.0 * focal), t),
            Geom::Hyperbola { frame: f, a, b, .. } => at(f, a * t.cosh(), b * t.sinh()),
            _ => panic!("not a curve: {g:?}"),
        }
    }

    fn eval_surface(g: &Geom, u: f64, v: f64) -> Vec3 {
        let at = |f: &Frame, a: f64, b: f64, c: f64| -> Vec3 {
            std::array::from_fn(|k| f.o[k] + a * f.x[k] + b * f.y[k] + c * f.z[k])
        };
        match g {
            Geom::Plane { frame: f, .. } => at(f, u, v, 0.0),
            Geom::Cylinder { frame: f, r, .. } => at(f, r * u.cos(), r * u.sin(), v),
            Geom::Cone { frame: f, semi_angle, ref_radius, .. } => {
                let radius = ref_radius + v * semi_angle.sin();
                at(f, radius * u.cos(), radius * u.sin(), v * semi_angle.cos())
            }
            Geom::Sphere { frame: f, r, .. } => at(f, r * v.cos() * u.cos(), r * v.cos() * u.sin(), r * v.sin()),
            Geom::Torus { frame: f, major, minor, .. } => {
                let rho = major + minor * v.cos();
                at(f, rho * u.cos(), rho * u.sin(), minor * v.sin())
            }
            _ => panic!("not a surface: {g:?}"),
        }
    }

    fn close(want: Point3D, got: Vec3) {
        let want = p3(want);
        let err = (0..3).map(|k| (want[k] - got[k]).powi(2)).sum::<f64>().sqrt();
        assert!(err <= TOL * want.iter().map(|x| x * x).sum::<f64>().sqrt().max(1.0), "{want:?} vs {got:?}");
    }

    const TS: [f64; 5] = [-1.3, -0.2, 0.0, 0.7, 2.9];

    fn p(x: f64, y: f64, z: f64) -> Point3D {
        Point3D::new(x, y, z)
    }

    fn v(x: f64, y: f64, z: f64) -> Vector3D {
        Vector3D::new(x, y, z)
    }

    #[test]
    fn analytic_curves_evaluate_like_geomcore() {
        let n = v(0.3, -0.5, 0.8);
        let curves: Vec<Curve3D> = vec![
            Line3D::new(p(1.0, 2.0, 3.0), v(0.2, 0.4, -1.0)).unwrap().into(),
            Circle3D::new(p(1.0, -2.0, 0.5), n, 2.5).unwrap().into(),
            Ellipse3D::new(p(-1.0, 0.0, 2.0), n, v(1.0, 1.0, 0.0), 3.0, 1.2).unwrap().into(),
            Parabola3D::new(p(0.0, 1.0, 0.0), n, v(0.0, 1.0, 1.0), 0.7).unwrap().into(),
            Hyperbola3D::new(p(2.0, 2.0, 2.0), n, v(1.0, 0.0, 0.0), 1.5, 0.5).unwrap().into(),
        ];
        for c in &curves {
            let g = Geom::from(c);
            for t in TS {
                close(c.eval_point(t), eval_curve(&g, t));
            }
        }
    }

    #[test]
    fn a_mirrored_circle_still_evaluates_like_geomcore() {
        let mirror = Transform::mirror_axis(Axis3D::new(Point3D::ORIGIN, Vector3D::X).unwrap());
        let c = Circle3D::new(p(1.0, 2.0, 0.0), v(0.0, 0.0, 1.0), 1.0).unwrap().transformed(mirror).unwrap();
        let g = Geom::from(&c);
        for t in TS {
            close(c.eval_point(t), eval_curve(&g, t));
        }
    }

    #[test]
    fn analytic_surfaces_evaluate_like_geomcore() {
        let axis = v(0.3, -0.5, 0.8);
        let turn = Transform::rotation(Axis3D::new(p(1.0, 0.0, 0.0), v(1.0, 1.0, 0.0)).unwrap(), 0.6);
        let surfaces: Vec<Surface> = vec![
            Plane::new(p(1.0, 2.0, 3.0), axis).unwrap().into(),
            Cylinder::new(p(0.0, 1.0, 0.0), axis, 2.0).unwrap().into(),
            Cone::new(p(1.0, 1.0, 1.0), axis, 0.4, 1.5).unwrap().into(),
            Cone::new(p(0.0, 0.0, 0.0), axis, 0.4, 0.0).unwrap().into(),
            Sphere::new(p(-1.0, 2.0, 0.5), 3.0).unwrap().transformed(turn).unwrap().into(),
            Torus::new(p(0.0, 0.0, 1.0), axis, 3.0, 1.0).unwrap().into(),
        ];
        for s in &surfaces {
            let g = Geom::from(s);
            for (u, w) in [(0.0, 0.0), (0.7, 0.3), (2.0, -1.1), (5.5, 1.4)] {
                close(s.eval_point(u, w), eval_surface(&g, u, w));
            }
        }
    }

    #[test]
    fn pcurves_from_parametrize_on_read_as_u_v() {
        let cylinder = Cylinder::new(Point3D::ORIGIN, v(0.0, 0.0, 1.0), 2.0).unwrap();
        let ring = Circle3D::new(p(0.0, 0.0, 3.0), v(0.0, 0.0, 1.0), 2.0).unwrap();
        let pc = ring.parametrize_on(cylinder, Tolerance::DEFAULT).unwrap();
        assert_eq!(Geom::from(&pc), Geom::line([0.0, 3.0, 0.0], [1.0, 0.0, 0.0]));
        let plane = Plane::new(Point3D::ORIGIN, v(0.0, 0.0, 1.0)).unwrap();
        let circle = Circle3D::new(p(1.0, 1.0, 0.0), v(0.0, 0.0, 1.0), 1.0).unwrap();
        let g = Geom::from(&circle.parametrize_on(plane, Tolerance::DEFAULT).unwrap());
        for t in TS {
            let (uv, xyz) = (eval_curve(&g, t), circle.eval_point(t));
            close(plane.eval_point(uv[0], uv[1]), p3(xyz));
        }
    }

    #[test]
    fn a_clockwise_2d_circle_keeps_its_direction() {
        let f = geomcore::Frame2D::new(Point2D::new(1.0, 2.0), Vector2D::X, Vector2D::new(0.0, -1.0)).unwrap();
        let c = Circle2D::from_frame(f, 2.0).unwrap();
        let g = Geom::from(&c);
        for t in TS {
            let want = c.eval_point(t);
            close(p(want.x, want.y, 0.0), eval_curve(&g, t));
        }
    }

    #[test]
    fn b_splines_keep_their_exact_definition() {
        let poles = vec![p(0.0, 0.0, 0.0), p(1.0, 2.0, 0.0), p(3.0, 2.0, 1.0), p(4.0, 0.0, 0.0)];
        let c = BSplineCurve3D::new(3, poles, vec![0.0, 1.0], vec![4, 4], false).unwrap();
        let Geom::BsplineCurve { degree, poles, weights, knots, multiplicities, periodic, range } = Geom::from(&c)
        else {
            panic!()
        };
        assert_eq!((degree, poles.len(), periodic, range), (3, 4, false, None));
        assert_eq!((knots, multiplicities), (vec![0.0, 1.0], vec![4, 4]));
        assert_eq!(weights, None);
        assert_eq!(poles[1], [1.0, 2.0, 0.0]);
        assert!(Geom::from(&c).problem().is_none());
        let grid = vec![vec![p(0.0, 0.0, 0.0), p(0.0, 1.0, 0.0)], vec![p(1.0, 0.0, 0.0), p(1.0, 1.0, 1.0)]];
        let s = BSplineSurface::new(1, 1, grid, vec![0.0, 1.0], vec![2, 2], vec![0.0, 1.0], vec![2, 2], false, false)
            .unwrap();
        let g = Geom::from(&s);
        assert!(g.problem().is_none());
        assert!(matches!(g, Geom::BsplineSurface { u_degree: 1, v_degree: 1, nu: 2, nv: 2, .. }));
    }

    #[test]
    fn finite_knot_ranges_are_kept_whole_not_clamped() {
        let poles = vec![p(0.0, 0.0, 0.0), p(1.0, 2.0, 0.0), p(3.0, 2.0, 1.0), p(4.0, 0.0, 0.0)];
        for (k0, k1) in [(0.0, 350.0), (200.0, 300.0)] {
            let c = BSplineCurve3D::new(3, poles.clone(), vec![k0, k1], vec![4, 4], false).unwrap();
            let Geom::BsplineCurve { knots, .. } = Geom::from(&c) else { panic!() };
            assert_eq!(knots, vec![k0, k1]);
        }
    }

    #[test]
    fn trimmed_curves_keep_their_basis_and_range() {
        let seg = TrimmedCurve3D::new(Line3D::new(p(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0)).unwrap(), 1.0, 3.0).unwrap();
        assert_eq!(Geom::from(&seg), Geom::line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]).range(1.0, 3.0));
        let arc =
            TrimmedCurve3D::new(Circle3D::new(p(1.0, 2.0, 0.0), v(0.0, 0.0, 1.0), 2.0).unwrap(), 0.0, 1.5).unwrap();
        let g = Geom::from(&arc);
        for t in TS {
            close(arc.eval_point(t), eval_curve(&g, t));
        }
        assert!(matches!(g, Geom::Circle { range: Some(_), .. }));
        let line2 = geomcore::Line2D::new(Point2D::new(0.0, 1.0), Vector2D::new(1.0, 0.0)).unwrap();
        let seg2 = TrimmedCurve2D::new(line2, -1.0, 2.0).unwrap();
        assert_eq!(Geom::from(&seg2), Geom::line([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]).range(-1.0, 2.0));
        let poles = vec![p(0.0, 0.0, 0.0), p(1.0, 2.0, 0.0), p(3.0, 2.0, 1.0), p(4.0, 0.0, 0.0)];
        let spline = BSplineCurve3D::new(3, poles, vec![0.0, 1.0], vec![4, 4], false).unwrap();
        let piece = TrimmedCurve3D::new(spline, 0.25, 0.75).unwrap();
        let Geom::BsplineCurve { knots, range, .. } = Geom::from(&piece) else { panic!() };
        assert_eq!(knots, vec![0.0, 1.0]);
        assert_eq!(range, Some([0.25, 0.75]));
    }

    #[test]
    fn runtime_enums_unwrap_to_their_geometry() {
        let line = Line3D::new(p(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0)).unwrap();
        assert_eq!(Geom::from(&ElementaryCurve::Line(line)), Geom::line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
        assert_eq!(Geom::from(&Curve3D::from(line)), Geom::line([0.0, 0.0, 0.0], [1.0, 0.0, 0.0]));
        let plane = Plane::new(Point3D::ORIGIN, v(0.0, 0.0, 1.0)).unwrap();
        assert_eq!(Geom::from(&ElementarySurface::Plane(plane)), Geom::plane(Frame::WORLD));
        assert_eq!(Geom::from(&Surface::from(plane)), Geom::plane(Frame::WORLD));
    }

    #[test]
    fn bounding_boxes_become_boxes() {
        use geomcore::{Bound3D, BoundingBox3D};
        let b = BoundingBox3D::new(p(0.0, 0.0, 0.0), p(1.0, 2.0, 3.0));
        assert_eq!(Geom::from(&b), Geom::bbox([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]));
        let line = Line3D::new(p(0.0, 0.0, 0.0), v(1.0, 0.0, 0.0)).unwrap();
        let seg = TrimmedCurve3D::new(line, 1.0, 3.0).unwrap();
        let bb = seg.bounding_box().unwrap();
        assert_eq!(Geom::from(&bb), Geom::bbox([1.0, 0.0, 0.0], [3.0, 0.0, 0.0]));
    }

    #[test]
    fn points_and_2d_points() {
        assert_eq!(Geom::from(p(1.0, 2.0, 3.0)), Geom::point([1.0, 2.0, 3.0]));
        assert_eq!(Geom::from(Point2D::new(1.0, 2.0)), Geom::point([1.0, 2.0, 0.0]));
    }

    #[test]
    fn degenerate_iso_curves_are_points() {
        use std::f64::consts::FRAC_PI_2;
        let sphere = Sphere::new(Point3D::ORIGIN, 2.0).unwrap();
        let Geom::Point { p: pole } = Geom::from(&sphere.v_iso(FRAC_PI_2).unwrap()) else {
            panic!("a pole is a point")
        };
        close(p(0.0, 0.0, 2.0), pole);
        let cone = Cone::new(Point3D::ORIGIN, Vector3D::Z, 0.5, 1.0).unwrap();
        assert!(matches!(Geom::from(&cone.v_iso(-1.0 / 0.5f64.sin()).unwrap()), Geom::Point { .. }));
        assert!(matches!(Geom::from(&cone.v_iso(0.0).unwrap()), Geom::Circle { .. }));
        let patch = sphere.to_bspline_patch((0.0, 3.0), (-1.0, FRAC_PI_2)).unwrap();
        let edge: Curve3D = patch.v_iso(FRAC_PI_2).unwrap().into();
        assert!(matches!(Geom::from(&edge), Geom::Point { .. }));
        assert!(matches!(Geom::from(&patch.v_iso(0.0).unwrap()), Geom::BsplineCurve { .. }));
    }
}
