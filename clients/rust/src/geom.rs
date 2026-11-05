//! Protocol v2 geometry (`protocol/SCENE.md`, "Geometry types").

use serde_json::{json, Map, Value};

/// `[x, y, z]`; a 2D point is `[x, y, 0.0]`.
pub type Vec3 = [f64; 3];

/// A placement: origin `o` and the unit axes `x`, `y`, `z` (right-handed, orthonormal).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub o: Vec3,
    pub x: Vec3,
    pub y: Vec3,
    pub z: Vec3,
}

impl Frame {
    /// The world axes at the origin.
    pub const WORLD: Frame = Frame { o: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 1.0, 0.0], z: [0.0, 0.0, 1.0] };

    /// The world axes moved to `o`.
    pub fn at(o: Vec3) -> Frame {
        Frame { o, ..Frame::WORLD }
    }

    /// A right-handed frame at `o` with main axis `z` and `x` taken from `x_hint`
    /// (its part perpendicular to `z`). `None` when `z` is zero or parallel to `x_hint`.
    pub fn new(o: Vec3, z: Vec3, x_hint: Vec3) -> Option<Frame> {
        let z = unit(z)?;
        let x = unit(sub(x_hint, scale(z, dot(x_hint, z))))?;
        Some(Frame { o, x, y: cross(z, x), z })
    }

    fn to_json(self) -> Value {
        json!({"o": self.o, "x": self.x, "y": self.y, "z": self.z})
    }
}

/// A surface's parameter window; a missing direction is filled by [`crate::Viewer`]
/// (full period when closed, ± the scene's extent when infinite).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Window {
    pub u: Option<[f64; 2]>,
    pub v: Option<[f64; 2]>,
}

/// `note` severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NoteLevel {
    #[default]
    Info,
    Warn,
}

/// One geometry, as on the wire. Curves take an optional parameter `range`,
/// surfaces a [`Window`]; the parametrizations are geomcore's (`protocol/SCENE.md`).
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Geom {
    Line {
        o: Vec3,
        d: Vec3,
        range: Option<[f64; 2]>,
    },
    Circle {
        frame: Frame,
        r: f64,
        range: Option<[f64; 2]>,
    },
    Ellipse {
        frame: Frame,
        a: f64,
        b: f64,
        range: Option<[f64; 2]>,
    },
    Parabola {
        frame: Frame,
        f: f64,
        range: Option<[f64; 2]>,
    },
    Hyperbola {
        frame: Frame,
        a: f64,
        b: f64,
        range: Option<[f64; 2]>,
    },
    Polyline {
        points: Vec<Vec3>,
    },
    /// An exact B-spline curve: degree, control poles, per-pole weights when
    /// rational, distinct knots with multiplicities, and periodicity. A
    /// trimmed piece carries its parameter `range`.
    BsplineCurve {
        degree: usize,
        poles: Vec<Vec3>,
        weights: Option<Vec<f64>>,
        knots: Vec<f64>,
        multiplicities: Vec<u32>,
        periodic: bool,
        range: Option<[f64; 2]>,
    },
    Plane {
        frame: Frame,
        window: Window,
    },
    Cylinder {
        frame: Frame,
        r: f64,
        window: Window,
    },
    Cone {
        frame: Frame,
        semi_angle: f64,
        ref_radius: f64,
        window: Window,
    },
    Sphere {
        frame: Frame,
        r: f64,
        window: Window,
    },
    /// `major` is the protocol's `R`, `minor` its `r`.
    Torus {
        frame: Frame,
        major: f64,
        minor: f64,
        window: Window,
    },
    Mesh {
        vertices: Vec<Vec3>,
        indices: Vec<u32>,
    },
    /// An exact B-spline surface: degrees, the pole net (`nu` rows of `nv`
    /// poles), per-pole weights when rational, distinct knots with
    /// multiplicities per direction, periodicity, and a [`Window`]. The
    /// domain comes from the knots; an explicit window shows a sub-region.
    BsplineSurface {
        u_degree: usize,
        v_degree: usize,
        nu: usize,
        nv: usize,
        poles: Vec<Vec3>,
        weights: Option<Vec<f64>>,
        u_knots: Vec<f64>,
        u_multiplicities: Vec<u32>,
        v_knots: Vec<f64>,
        v_multiplicities: Vec<u32>,
        u_periodic: bool,
        v_periodic: bool,
        window: Window,
    },
    /// An axis-aligned box: the points between the `min` and `max` corners.
    /// Either corner may hold the smaller coordinates; the viewer draws the
    /// twelve edges. (From a geomcore `BoundingBox3D` once the client moves
    /// past geomcore 0.28, which has no bounding boxes yet.)
    Box {
        min: Vec3,
        max: Vec3,
    },
    Point {
        p: Vec3,
    },
    Points {
        positions: Vec<Vec3>,
        size: Option<f64>,
    },
    Arrow {
        at: Vec3,
        vec: Vec3,
    },
    Text {
        at: Vec3,
        text: String,
    },
    Note {
        text: String,
        level: NoteLevel,
    },
    /// A curve in a surface's (u, v) parameter space: `curve` is a `Line`,
    /// `Circle` or `Polyline` in z = 0 whose x, y are read as u, v. Built by
    /// [`crate::Viewer::pcurve`], which fills `surface` with the surface's id.
    Pcurve {
        surface: String,
        curve: Box<Geom>,
    },
}

impl Geom {
    pub fn line(o: Vec3, d: Vec3) -> Geom {
        Geom::Line { o, d, range: None }
    }
    pub fn circle(frame: Frame, r: f64) -> Geom {
        Geom::Circle { frame, r, range: None }
    }
    pub fn ellipse(frame: Frame, a: f64, b: f64) -> Geom {
        Geom::Ellipse { frame, a, b, range: None }
    }
    pub fn parabola(frame: Frame, f: f64) -> Geom {
        Geom::Parabola { frame, f, range: None }
    }
    pub fn hyperbola(frame: Frame, a: f64, b: f64) -> Geom {
        Geom::Hyperbola { frame, a, b, range: None }
    }
    pub fn polyline(points: Vec<Vec3>) -> Geom {
        Geom::Polyline { points }
    }
    pub fn bspline_curve(
        degree: usize,
        poles: Vec<Vec3>,
        weights: Option<Vec<f64>>,
        knots: Vec<f64>,
        multiplicities: Vec<u32>,
        periodic: bool,
    ) -> Geom {
        Geom::BsplineCurve { degree, poles, weights, knots, multiplicities, periodic, range: None }
    }
    pub fn plane(frame: Frame) -> Geom {
        Geom::Plane { frame, window: Window::default() }
    }
    pub fn cylinder(frame: Frame, r: f64) -> Geom {
        Geom::Cylinder { frame, r, window: Window::default() }
    }
    pub fn cone(frame: Frame, semi_angle: f64, ref_radius: f64) -> Geom {
        Geom::Cone { frame, semi_angle, ref_radius, window: Window::default() }
    }
    pub fn sphere(frame: Frame, r: f64) -> Geom {
        Geom::Sphere { frame, r, window: Window::default() }
    }
    pub fn torus(frame: Frame, major: f64, minor: f64) -> Geom {
        Geom::Torus { frame, major, minor, window: Window::default() }
    }
    pub fn mesh(vertices: Vec<Vec3>, indices: Vec<u32>) -> Geom {
        Geom::Mesh { vertices, indices }
    }
    pub fn bbox(min: Vec3, max: Vec3) -> Geom {
        Geom::Box { min, max }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn bspline_surface(
        u_degree: usize,
        v_degree: usize,
        nu: usize,
        nv: usize,
        poles: Vec<Vec3>,
        weights: Option<Vec<f64>>,
        u_knots: Vec<f64>,
        u_multiplicities: Vec<u32>,
        v_knots: Vec<f64>,
        v_multiplicities: Vec<u32>,
        u_periodic: bool,
        v_periodic: bool,
    ) -> Geom {
        Geom::BsplineSurface {
            u_degree,
            v_degree,
            nu,
            nv,
            poles,
            weights,
            u_knots,
            u_multiplicities,
            v_knots,
            v_multiplicities,
            u_periodic,
            v_periodic,
            window: Window::default(),
        }
    }
    pub fn point(p: Vec3) -> Geom {
        Geom::Point { p }
    }
    pub fn points(positions: Vec<Vec3>) -> Geom {
        Geom::Points { positions, size: None }
    }
    pub fn arrow(at: Vec3, vec: Vec3) -> Geom {
        Geom::Arrow { at, vec }
    }
    pub fn text(at: Vec3, text: &str) -> Geom {
        Geom::Text { at, text: text.into() }
    }
    pub fn note(text: &str, level: NoteLevel) -> Geom {
        Geom::Note { text: text.into(), level }
    }

    /// A curve limited to `t0 ..= t1`; other geometry is returned unchanged.
    pub fn range(mut self, t0: f64, t1: f64) -> Geom {
        match &mut self {
            Geom::Line { range, .. }
            | Geom::Circle { range, .. }
            | Geom::Ellipse { range, .. }
            | Geom::Parabola { range, .. }
            | Geom::Hyperbola { range, .. }
            | Geom::BsplineCurve { range, .. } => *range = Some([t0, t1]),
            _ => {}
        }
        self
    }

    /// A surface limited to `u` × `v` (a `None` keeps the default); other geometry is returned unchanged.
    pub fn window(mut self, u: Option<[f64; 2]>, v: Option<[f64; 2]>) -> Geom {
        if let Some(w) = self.window_mut() {
            w.u = u.or(w.u);
            w.v = v.or(w.v);
        }
        self
    }

    /// The protocol's `geom.type`.
    pub fn kind(&self) -> &'static str {
        match self {
            Geom::Line { .. } => "line",
            Geom::Circle { .. } => "circle",
            Geom::Ellipse { .. } => "ellipse",
            Geom::Parabola { .. } => "parabola",
            Geom::Hyperbola { .. } => "hyperbola",
            Geom::Polyline { .. } => "polyline",
            Geom::BsplineCurve { .. } => "bspline_curve",
            Geom::Plane { .. } => "plane",
            Geom::Cylinder { .. } => "cylinder",
            Geom::Cone { .. } => "cone",
            Geom::Sphere { .. } => "sphere",
            Geom::Torus { .. } => "torus",
            Geom::Mesh { .. } => "mesh",
            Geom::BsplineSurface { .. } => "bspline_surface",
            Geom::Box { .. } => "box",
            Geom::Point { .. } => "point",
            Geom::Points { .. } => "points",
            Geom::Arrow { .. } => "arrow",
            Geom::Text { .. } => "text",
            Geom::Note { .. } => "note",
            Geom::Pcurve { .. } => "pcurve",
        }
    }

    pub fn is_surface(&self) -> bool {
        matches!(
            self,
            Geom::Plane { .. }
                | Geom::Cylinder { .. }
                | Geom::Cone { .. }
                | Geom::Sphere { .. }
                | Geom::Torus { .. }
                | Geom::BsplineSurface { .. }
        )
    }

    pub(crate) fn window_mut(&mut self) -> Option<&mut Window> {
        match self {
            Geom::Plane { window, .. }
            | Geom::Cylinder { window, .. }
            | Geom::Cone { window, .. }
            | Geom::Sphere { window, .. }
            | Geom::Torus { window, .. }
            | Geom::BsplineSurface { window, .. } => Some(window),
            _ => None,
        }
    }

    /// Why the viewer would reject this geometry, checked before anything is sent:
    /// a non-finite number, a radius that is not positive, a zero direction,
    /// too few points or poles, mismatched weights, knots or multiplicities,
    /// or a malformed mesh or pcurve.
    pub fn problem(&self) -> Option<String> {
        let mut nums: Vec<f64> = Vec::new();
        self.numbers(&mut nums);
        if nums.iter().any(|x| !x.is_finite()) {
            return Some(format!("{} has NaN or infinite values", self.kind()));
        }
        let kind = self.kind();
        let positive = |name: &str, x: f64| (x <= 0.0).then(|| format!("{kind}.{name} must be positive"));
        match self {
            Geom::Line { d, .. } if *d == [0.0; 3] => Some("line.d must be non-zero".into()),
            Geom::Circle { r, .. } | Geom::Cylinder { r, .. } | Geom::Sphere { r, .. } => positive("r", *r),
            Geom::Ellipse { a, b, .. } | Geom::Hyperbola { a, b, .. } => {
                positive("a", *a).or_else(|| positive("b", *b))
            }
            Geom::Torus { major, minor, .. } => positive("R", *major).or_else(|| positive("r", *minor)),
            Geom::Parabola { f, .. } if *f == 0.0 => Some("parabola.f must be non-zero".into()),
            Geom::Polyline { points } if points.len() < 2 => Some("polyline.points needs at least 2 points".into()),
            Geom::BsplineCurve { degree, poles, weights, knots, multiplicities, periodic, .. } => {
                bspline_problem("bspline_curve", *degree, poles.len(), weights, knots, multiplicities, *periodic)
            }
            Geom::BsplineSurface {
                u_degree,
                v_degree,
                nu,
                nv,
                poles,
                weights,
                u_knots,
                u_multiplicities,
                v_knots,
                v_multiplicities,
                u_periodic,
                v_periodic,
                ..
            } => {
                if poles.len() != nu * nv {
                    return Some("bspline_surface.poles must hold nu × nv points".into());
                }
                if weights.as_ref().is_some_and(|w| w.len() != poles.len()) {
                    return Some("bspline_surface.weights must hold one weight per pole".into());
                }
                bspline_problem("bspline_surface.u", *u_degree, *nu, &None, u_knots, u_multiplicities, *u_periodic)
                    .or_else(|| {
                        bspline_problem(
                            "bspline_surface.v",
                            *v_degree,
                            *nv,
                            &None,
                            v_knots,
                            v_multiplicities,
                            *v_periodic,
                        )
                    })
            }
            Geom::Points { positions, .. } if positions.is_empty() => Some("points.positions must not be empty".into()),
            Geom::Mesh { vertices, indices } => {
                let n = vertices.len();
                (indices.is_empty() || indices.len() % 3 != 0 || indices.iter().any(|&i| i as usize >= n))
                    .then(|| "mesh.indices must be triangles indexing vertices".into())
            }
            Geom::Pcurve { curve, .. } => match **curve {
                Geom::Line { .. } | Geom::Circle { .. } | Geom::Polyline { .. } => {
                    if !in_z0(curve) {
                        Some("pcurve.curve must lie in z = 0 (x is u, y is v)".into())
                    } else {
                        curve.problem()
                    }
                }
                _ => Some(format!("a pcurve is a line, circle or polyline in (u, v), got {}", curve.kind())),
            },
            _ => None,
        }
    }

    fn numbers(&self, out: &mut Vec<f64>) {
        let frame = |out: &mut Vec<f64>, f: &Frame| [f.o, f.x, f.y, f.z].iter().for_each(|v| out.extend(v));
        let pair = |out: &mut Vec<f64>, r: &Option<[f64; 2]>| out.extend(r.iter().flatten());
        let window = |out: &mut Vec<f64>, w: &Window| {
            pair(out, &w.u);
            pair(out, &w.v)
        };
        match self {
            Geom::Line { o, d, range } => {
                out.extend(o.iter().chain(d));
                pair(out, range)
            }
            Geom::Circle { frame: f, r, range } => {
                frame(out, f);
                out.push(*r);
                pair(out, range)
            }
            Geom::Ellipse { frame: f, a, b, range } | Geom::Hyperbola { frame: f, a, b, range } => {
                frame(out, f);
                out.extend([*a, *b]);
                pair(out, range)
            }
            Geom::Parabola { frame: f, f: focal, range } => {
                frame(out, f);
                out.push(*focal);
                pair(out, range)
            }
            Geom::Polyline { points } => points.iter().for_each(|p| out.extend(p)),
            Geom::BsplineCurve { poles, weights, knots, range, .. } => {
                poles.iter().for_each(|p| out.extend(p));
                if let Some(w) = weights {
                    out.extend(w);
                }
                out.extend(knots);
                pair(out, range);
            }
            Geom::Plane { frame: f, window: w } => {
                frame(out, f);
                window(out, w)
            }
            Geom::Cylinder { frame: f, r, window: w } | Geom::Sphere { frame: f, r, window: w } => {
                frame(out, f);
                out.push(*r);
                window(out, w)
            }
            Geom::Cone { frame: f, semi_angle, ref_radius, window: w } => {
                frame(out, f);
                out.extend([*semi_angle, *ref_radius]);
                window(out, w)
            }
            Geom::Torus { frame: f, major, minor, window: w } => {
                frame(out, f);
                out.extend([*major, *minor]);
                window(out, w)
            }
            Geom::Mesh { vertices, .. } => vertices.iter().for_each(|p| out.extend(p)),
            Geom::BsplineSurface { poles, weights, u_knots, v_knots, window: w, .. } => {
                poles.iter().for_each(|p| out.extend(p));
                if let Some(w8) = weights {
                    out.extend(w8);
                }
                out.extend(u_knots);
                out.extend(v_knots);
                window(out, w);
            }
            Geom::Box { min, max } => out.extend(min.iter().chain(max)),
            Geom::Point { p } => out.extend(p),
            Geom::Points { positions, size } => {
                positions.iter().for_each(|p| out.extend(p));
                out.extend(size)
            }
            Geom::Arrow { at, vec } => out.extend(at.iter().chain(vec)),
            Geom::Text { at, .. } => out.extend(at),
            Geom::Note { .. } => {}
            Geom::Pcurve { curve, .. } => curve.numbers(out),
        }
    }

    /// The `geom` JSON object.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), self.kind().into());
        let mut put = |k: &str, v: Value| {
            m.insert(k.into(), v);
        };
        match self {
            Geom::Line { o, d, range } => {
                put("o", json!(o));
                put("d", json!(d));
                put_range(&mut put, range);
            }
            Geom::Circle { frame, r, range } => {
                put("frame", frame.to_json());
                put("r", json!(r));
                put_range(&mut put, range);
            }
            Geom::Ellipse { frame, a, b, range } | Geom::Hyperbola { frame, a, b, range } => {
                put("frame", frame.to_json());
                put("a", json!(a));
                put("b", json!(b));
                put_range(&mut put, range);
            }
            Geom::Parabola { frame, f, range } => {
                put("frame", frame.to_json());
                put("f", json!(f));
                put_range(&mut put, range);
            }
            Geom::Polyline { points } => put("points", json!(points)),
            Geom::BsplineCurve { degree, poles, weights, knots, multiplicities, periodic, range } => {
                put("degree", json!(degree));
                put("poles", json!(poles));
                if let Some(w) = weights {
                    put("weights", json!(w));
                }
                put("knots", json!(knots));
                put("multiplicities", json!(multiplicities));
                put("periodic", json!(periodic));
                put_range(&mut put, range);
            }
            Geom::Plane { frame, window } => {
                put("frame", frame.to_json());
                put_window(&mut put, window);
            }
            Geom::Cylinder { frame, r, window } | Geom::Sphere { frame, r, window } => {
                put("frame", frame.to_json());
                put("r", json!(r));
                put_window(&mut put, window);
            }
            Geom::Cone { frame, semi_angle, ref_radius, window } => {
                put("frame", frame.to_json());
                put("semi_angle", json!(semi_angle));
                put("ref_radius", json!(ref_radius));
                put_window(&mut put, window);
            }
            Geom::Torus { frame, major, minor, window } => {
                put("frame", frame.to_json());
                put("R", json!(major));
                put("r", json!(minor));
                put_window(&mut put, window);
            }
            Geom::Mesh { vertices, indices } => {
                put("vertices", json!(vertices));
                put("indices", json!(indices));
            }
            Geom::BsplineSurface {
                u_degree,
                v_degree,
                nu,
                nv,
                poles,
                weights,
                u_knots,
                u_multiplicities,
                v_knots,
                v_multiplicities,
                u_periodic,
                v_periodic,
                window,
            } => {
                put("u_degree", json!(u_degree));
                put("v_degree", json!(v_degree));
                put("nu", json!(nu));
                put("nv", json!(nv));
                put("poles", json!(poles));
                if let Some(w) = weights {
                    put("weights", json!(w));
                }
                put("u_knots", json!(u_knots));
                put("u_multiplicities", json!(u_multiplicities));
                put("v_knots", json!(v_knots));
                put("v_multiplicities", json!(v_multiplicities));
                put("u_periodic", json!(u_periodic));
                put("v_periodic", json!(v_periodic));
                put_window(&mut put, window);
            }
            Geom::Box { min, max } => {
                put("min", json!(min));
                put("max", json!(max));
            }
            Geom::Point { p } => put("p", json!(p)),
            Geom::Points { positions, size } => {
                put("positions", json!(positions));
                if let Some(s) = size {
                    put("size", json!(s));
                }
            }
            Geom::Arrow { at, vec } => {
                put("at", json!(at));
                put("vec", json!(vec));
            }
            Geom::Text { at, text } => {
                put("at", json!(at));
                put("text", json!(text));
            }
            Geom::Note { text, level } => {
                put("text", json!(text));
                put("level", json!(if *level == NoteLevel::Warn { "warn" } else { "info" }));
            }
            Geom::Pcurve { surface, curve } => {
                put("surface", json!(surface));
                put("curve", curve.to_json());
            }
        }
        Value::Object(m)
    }
}

fn put_range(put: &mut impl FnMut(&str, Value), range: &Option<[f64; 2]>) {
    if let Some(r) = range {
        put("range", json!(r));
    }
}

/// Why a B-spline direction is malformed, mirroring the kernel's construction
/// rules: `n` poles need `sum(mults) - degree - 1` (open) or
/// `sum(mults) - mults[last]` (periodic).
fn bspline_problem(
    what: &str,
    degree: usize,
    n: usize,
    weights: &Option<Vec<f64>>,
    knots: &[f64],
    multiplicities: &[u32],
    periodic: bool,
) -> Option<String> {
    if degree < 1 {
        return Some(format!("{what}.degree must be at least 1"));
    }
    if n < 2 {
        return Some(format!("{what} needs at least 2 poles"));
    }
    if weights.as_ref().is_some_and(|w| w.len() != n) {
        return Some(format!("{what}.weights must hold one weight per pole"));
    }
    if weights.as_ref().is_some_and(|w| w.iter().any(|&x| x <= 0.0)) {
        return Some(format!("{what}.weights must be positive"));
    }
    if knots.len() != multiplicities.len() || knots.is_empty() {
        return Some(format!("{what} needs matching non-empty knots and multiplicities"));
    }
    if multiplicities.iter().any(|&m| m < 1) {
        return Some(format!("{what}.multiplicities must hold at least 1"));
    }
    let sum: usize = multiplicities.iter().map(|&m| m as usize).sum();
    let want = if periodic { sum - multiplicities.last().copied().unwrap_or(0) as usize } else { sum - degree - 1 };
    (n != want).then(|| format!("{what} holds {n} poles but its knots describe {want}"))
}

fn put_window(put: &mut impl FnMut(&str, Value), w: &Window) {
    if w.u.is_none() && w.v.is_none() {
        return;
    }
    let mut m = Map::new();
    if let Some(u) = w.u {
        m.insert("u".into(), json!(u));
    }
    if let Some(v) = w.v {
        m.insert("v".into(), json!(v));
    }
    put("window", Value::Object(m));
}

pub(crate) fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub(crate) fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub(crate) fn norm(a: Vec3) -> f64 {
    dot(a, a).sqrt()
}

fn unit(a: Vec3) -> Option<Vec3> {
    let n = norm(a);
    (n > 1e-12 && n.is_finite()).then(|| scale(a, 1.0 / n))
}

/// A (u, v) curve as a pcurve needs it: a line, circle or polyline lying in z = 0, within
/// the viewer's own tolerance (`inPlaneZ0` in frontend/src/geom/planar.ts), so the client
/// rejects exactly what the viewer would flag.
fn in_z0(curve: &Geom) -> bool {
    const EPS: f64 = 1e-9;
    let flat = |p: &Vec3| p[2].abs() < EPS;
    match curve {
        Geom::Line { o, d, .. } => flat(o) && flat(d),
        Geom::Circle { frame: f, .. } => flat(&f.o) && f.z[0].abs() < EPS && f.z[1].abs() < EPS,
        Geom::Polyline { points } => points.iter().all(flat),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: Frame = Frame::WORLD;

    #[test]
    fn curves_match_the_protocol() {
        assert_eq!(
            Geom::line([1.0, 2.0, 0.0], [0.0, 1.0, 0.0]).range(-1.0, 2.0).to_json(),
            json!({"type": "line", "o": [1.0, 2.0, 0.0], "d": [0.0, 1.0, 0.0], "range": [-1.0, 2.0]})
        );
        let frame = json!({"o": [0.0, 0.0, 0.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]});
        assert_eq!(Geom::circle(F, 2.0).to_json(), json!({"type": "circle", "frame": frame, "r": 2.0}));
        assert_eq!(
            Geom::ellipse(F, 3.0, 2.0).to_json(),
            json!({"type": "ellipse", "frame": frame, "a": 3.0, "b": 2.0})
        );
        assert_eq!(Geom::parabola(F, 0.5).to_json(), json!({"type": "parabola", "frame": frame, "f": 0.5}));
        assert_eq!(
            Geom::hyperbola(F, 1.0, 2.0).to_json(),
            json!({"type": "hyperbola", "frame": frame, "a": 1.0, "b": 2.0})
        );
        assert_eq!(
            Geom::polyline(vec![[0.0; 3], [1.0, 0.0, 0.0]]).to_json(),
            json!({"type": "polyline", "points": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]]})
        );
        assert_eq!(
            Geom::bspline_curve(1, vec![[0.0; 3], [1.0, 0.0, 0.0]], None, vec![0.0, 1.0], vec![2, 2], false)
                .range(0.0, 0.5)
                .to_json(),
            json!({"type": "bspline_curve", "degree": 1, "poles": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                   "knots": [0.0, 1.0], "multiplicities": [2, 2], "periodic": false, "range": [0.0, 0.5]})
        );
    }

    #[test]
    fn surfaces_match_the_protocol() {
        let frame = json!({"o": [0.0, 0.0, 1.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]});
        let f = Frame::at([0.0, 0.0, 1.0]);
        assert_eq!(Geom::plane(f).to_json(), json!({"type": "plane", "frame": frame}));
        assert_eq!(
            Geom::cylinder(f, 2.0).window(None, Some([-1.0, 1.0])).to_json(),
            json!({"type": "cylinder", "frame": frame, "r": 2.0, "window": {"v": [-1.0, 1.0]}})
        );
        assert_eq!(
            Geom::cone(f, 0.5, 0.0).to_json(),
            json!({"type": "cone", "frame": frame, "semi_angle": 0.5, "ref_radius": 0.0})
        );
        assert_eq!(Geom::sphere(f, 1.0).to_json(), json!({"type": "sphere", "frame": frame, "r": 1.0}));
        assert_eq!(Geom::torus(f, 3.0, 1.0).to_json(), json!({"type": "torus", "frame": frame, "R": 3.0, "r": 1.0}));
        assert_eq!(
            Geom::bspline_surface(
                1,
                1,
                2,
                2,
                vec![[0.0; 3], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 1.0]],
                None,
                vec![0.0, 1.0],
                vec![2, 2],
                vec![0.0, 1.0],
                vec![2, 2],
                false,
                false
            )
            .to_json(),
            json!({"type": "bspline_surface", "u_degree": 1, "v_degree": 1, "nu": 2, "nv": 2,
                   "poles": [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 1.0]],
                   "u_knots": [0.0, 1.0], "u_multiplicities": [2, 2],
                   "v_knots": [0.0, 1.0], "v_multiplicities": [2, 2],
                   "u_periodic": false, "v_periodic": false})
        );
    }

    #[test]
    fn markers_and_raw_geometry_match_the_protocol() {
        assert_eq!(Geom::point([1.0, 2.0, 3.0]).to_json(), json!({"type": "point", "p": [1.0, 2.0, 3.0]}));
        assert_eq!(
            Geom::Points { positions: vec![[0.0; 3]], size: Some(3.0) }.to_json(),
            json!({"type": "points", "positions": [[0.0, 0.0, 0.0]], "size": 3.0})
        );
        assert_eq!(
            Geom::mesh(vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![0, 1, 2]).to_json(),
            json!({"type": "mesh", "vertices": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], "indices": [0, 1, 2]})
        );
        assert_eq!(
            Geom::bbox([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]).to_json(),
            json!({"type": "box", "min": [0.0, 0.0, 0.0], "max": [1.0, 2.0, 3.0]})
        );
        assert_eq!(
            Geom::arrow([0.0; 3], [1.0, 0.0, 0.0]).to_json(),
            json!({"type": "arrow", "at": [0.0, 0.0, 0.0], "vec": [1.0, 0.0, 0.0]})
        );
        assert_eq!(Geom::text([0.0; 3], "A").to_json(), json!({"type": "text", "at": [0.0, 0.0, 0.0], "text": "A"}));
        assert_eq!(
            Geom::note("P: ∅", NoteLevel::Warn).to_json(),
            json!({"type": "note", "text": "P: ∅", "level": "warn"})
        );
        let pc = Geom::Pcurve { surface: "S".into(), curve: Box::new(Geom::line([0.0, 3.0, 0.0], [1.0, 0.0, 0.0])) };
        assert_eq!(
            pc.to_json(),
            json!({"type": "pcurve", "surface": "S", "curve": {"type": "line", "o": [0.0, 3.0, 0.0], "d": [1.0, 0.0, 0.0]}})
        );
    }

    #[test]
    fn range_and_window_only_apply_where_they_mean_something() {
        assert_eq!(Geom::point([0.0; 3]).range(0.0, 1.0), Geom::point([0.0; 3]));
        assert_eq!(Geom::circle(F, 1.0).window(Some([0.0, 1.0]), None), Geom::circle(F, 1.0));
        let w = Geom::plane(F).window(Some([0.0, 1.0]), None).window(None, Some([2.0, 3.0]));
        assert_eq!(w, Geom::Plane { frame: F, window: Window { u: Some([0.0, 1.0]), v: Some([2.0, 3.0]) } });
    }

    #[test]
    fn frame_new_is_right_handed_and_orthonormal() {
        let f = Frame::new([1.0, 0.0, 0.0], [0.0, 0.0, 2.0], [1.0, 0.0, 5.0]).unwrap();
        assert_eq!((f.x, f.y, f.z), ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]));
        assert!(Frame::new([0.0; 3], [0.0; 3], [1.0, 0.0, 0.0]).is_none());
        assert!(Frame::new([0.0; 3], [0.0, 0.0, 1.0], [0.0, 0.0, 3.0]).is_none());
    }

    #[test]
    fn problems_are_found_before_sending() {
        assert_eq!(Geom::circle(F, f64::NAN).problem().unwrap(), "circle has NaN or infinite values");
        assert_eq!(Geom::circle(F, 0.0).problem().unwrap(), "circle.r must be positive");
        assert_eq!(Geom::torus(F, 3.0, -1.0).problem().unwrap(), "torus.r must be positive");
        assert_eq!(Geom::line([0.0; 3], [0.0; 3]).problem().unwrap(), "line.d must be non-zero");
        assert_eq!(Geom::parabola(F, 0.0).problem().unwrap(), "parabola.f must be non-zero");
        assert!(Geom::polyline(vec![[0.0; 3]]).problem().is_some());
        assert!(Geom::mesh(vec![[0.0; 3]], vec![0, 0, 1]).problem().is_some());
        assert!(Geom::bbox([0.0; 3], [f64::NAN, 0.0, 0.0]).problem().is_some());
        assert!(Geom::bbox([0.0; 3], [1.0, 2.0, 3.0]).problem().is_none());
        let spline = Geom::bspline_curve(
            3,
            vec![[0.0; 3], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0], [3.0, 0.0, 0.0]],
            None,
            vec![0.0, 1.0],
            vec![4, 4],
            false,
        );
        assert!(spline.problem().is_none());
        assert_eq!(
            Geom::bspline_curve(0, vec![[0.0; 3], [1.0, 0.0, 0.0]], None, vec![0.0, 1.0], vec![2, 2], false)
                .problem()
                .unwrap(),
            "bspline_curve.degree must be at least 1"
        );
        assert_eq!(
            Geom::bspline_curve(1, vec![[0.0; 3], [1.0, 0.0, 0.0]], None, vec![0.0, 1.0], vec![2, 1], false)
                .problem()
                .unwrap(),
            "bspline_curve holds 2 poles but its knots describe 1"
        );
        assert_eq!(
            Geom::bspline_curve(1, vec![[0.0; 3], [1.0, 0.0, 0.0]], Some(vec![1.0]), vec![0.0, 1.0], vec![2, 2], false)
                .problem()
                .unwrap(),
            "bspline_curve.weights must hold one weight per pole"
        );
        assert_eq!(
            Geom::bspline_curve(
                1,
                vec![[0.0; 3], [1.0, 0.0, 0.0]],
                Some(vec![1.0, 0.0]),
                vec![0.0, 1.0],
                vec![2, 2],
                false
            )
            .problem()
            .unwrap(),
            "bspline_curve.weights must be positive"
        );
        let bad = Geom::Pcurve { surface: "S".into(), curve: Box::new(Geom::ellipse(F, 2.0, 1.0)) };
        assert_eq!(bad.problem().unwrap(), "a pcurve is a line, circle or polyline in (u, v), got ellipse");
        assert!(Geom::cone(F, 0.5, -1.0).problem().is_none(), "a cone's ref_radius may be negative");
        assert!(Geom::sphere(F, 1.0).window(Some([0.0, f64::INFINITY]), None).problem().is_some());
    }

    #[test]
    fn a_pcurve_must_lie_in_z0() {
        let flat = Frame::WORLD;
        let tilted = Frame { o: [0.0; 3], x: [1.0, 0.0, 0.0], y: [0.0, 0.0, 1.0], z: [0.0, -1.0, 0.0] };
        let high = Frame::at([0.0, 0.0, 5.0]);
        let pcurve = |curve| Geom::Pcurve { surface: "S".into(), curve: Box::new(curve) };
        for bad in [
            pcurve(Geom::line([0.0; 3], [0.0, 0.0, 1.0])),
            pcurve(Geom::circle(tilted, 1.0)),
            pcurve(Geom::circle(high, 1.0)),
            pcurve(Geom::polyline(vec![[0.0, 0.0, 5.0], [1.0, 1.0, 5.0]])),
        ] {
            assert_eq!(bad.problem().unwrap(), "pcurve.curve must lie in z = 0 (x is u, y is v)");
        }
        assert!(pcurve(Geom::line([0.0, 3.0, 0.0], [1.0, 0.0, 0.0])).problem().is_none());
        assert!(pcurve(Geom::circle(flat, 1.0)).problem().is_none());
        assert!(pcurve(Geom::polyline(vec![[0.0; 3], [1.0, 2.0, 0.0]])).problem().is_none());
        // the viewer's tolerance: rounding noise below 1e-9 passes, 1e-6 does not
        assert!(pcurve(Geom::polyline(vec![[0.0, 0.0, 1e-15], [1.0, 2.0, -1e-12]])).problem().is_none());
        assert!(pcurve(Geom::line([0.0, 0.0, 1e-6], [1.0, 0.0, 0.0])).problem().is_some());
    }
}
