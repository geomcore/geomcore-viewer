//! Scene objects: geometry plus id, label, group, style and extras (`protocol/SCENE.md`, "Document").

use serde_json::{json, Map, Value};

use crate::geom::Geom;

/// Categorical palette, the Python client's: every colour has contrast ≥ 3:1 on the
/// viewer's light (#f7f8fa) and dark (#16181d) backgrounds.
pub const PALETTE: [&str; 8] = ["#d1495b", "#00798c", "#c47f00", "#3a7cc2", "#8a5cc2", "#5c8a00", "#b5448f", "#6b7a8f"];

/// Extras the viewer draws: curves `foci`, `center`, `axes`, `asymptotes`, `directrix`,
/// `vertex`; surfaces `isolines` (`[nu, nv]`) and `wire`.
pub const EXTRAS: [&str; 8] = ["foci", "center", "axes", "asymptotes", "directrix", "vertex", "isolines", "wire"];

/// `color` (CSS), `width` (px), `dashed`, `opacity` (0–1); unset fields keep the viewer's default.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Style {
    pub color: Option<String>,
    pub width: Option<f64>,
    pub dashed: Option<bool>,
    pub opacity: Option<f64>,
}

impl Style {
    pub fn new() -> Style {
        Style::default()
    }
    pub fn color(mut self, css: &str) -> Style {
        self.color = Some(css.into());
        self
    }
    pub fn width(mut self, px: f64) -> Style {
        self.width = Some(px);
        self
    }
    pub fn dashed(mut self, dashed: bool) -> Style {
        self.dashed = Some(dashed);
        self
    }
    pub fn opacity(mut self, opacity: f64) -> Style {
        self.opacity = Some(opacity);
        self
    }

    /// `self` with every field `over` sets replaced.
    pub(crate) fn merged(&self, over: &Style) -> Style {
        Style {
            color: over.color.clone().or_else(|| self.color.clone()),
            width: over.width.or(self.width),
            dashed: over.dashed.or(self.dashed),
            opacity: over.opacity.or(self.opacity),
        }
    }

    /// Why the viewer would reject this style: a width that is not a positive number,
    /// an opacity outside 0–1.
    pub fn problem(&self) -> Option<String> {
        match (self.width, self.opacity) {
            (Some(w), _) if !(w.is_finite() && w > 0.0) => {
                Some(format!("style.width must be a positive number, got {w}"))
            }
            (_, Some(o)) if !(0.0..=1.0).contains(&o) => Some(format!("style.opacity must be within 0–1, got {o}")),
            _ => None,
        }
    }

    fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(c) = &self.color {
            m.insert("color".into(), json!(c));
        }
        if let Some(w) = self.width {
            m.insert("width".into(), json!(w));
        }
        if let Some(d) = self.dashed {
            m.insert("dashed".into(), json!(d));
        }
        if let Some(o) = self.opacity {
            m.insert("opacity".into(), json!(o));
        }
        Value::Object(m)
    }
}

/// How to show what [`crate::Viewer::add`] adds: label, group, style and extras.
///
/// ```
/// use geomcore_viewer::Opts;
/// let opts = Opts::new().label("E").group("conics").color("#d1495b").extra("foci", true);
/// # let _ = opts;
/// ```
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Opts {
    pub(crate) label: Option<String>,
    pub(crate) group: Option<String>,
    pub(crate) style: Style,
    pub(crate) extras: Map<String, Value>,
}

impl Opts {
    pub fn new() -> Opts {
        Opts::default()
    }
    /// Display name, and the object's id: re-adding a label replaces what it showed before.
    pub fn label(mut self, label: &str) -> Opts {
        self.label = Some(label.into());
        self
    }
    /// Panel group (one visibility toggle for all its objects).
    pub fn group(mut self, group: &str) -> Opts {
        self.group = Some(group.into());
        self
    }
    pub fn style(mut self, style: Style) -> Opts {
        self.style = self.style.merged(&style);
        self
    }
    pub fn color(self, css: &str) -> Opts {
        self.style(Style::new().color(css))
    }
    pub fn width(self, px: f64) -> Opts {
        self.style(Style::new().width(px))
    }
    pub fn dashed(self, dashed: bool) -> Opts {
        self.style(Style::new().dashed(dashed))
    }
    pub fn opacity(self, opacity: f64) -> Opts {
        self.style(Style::new().opacity(opacity))
    }
    /// One of [`EXTRAS`], e.g. `extra("foci", true)` or `extra("isolines", [8, 4])`.
    pub fn extra(mut self, name: &str, value: impl Into<Value>) -> Opts {
        self.extras.insert(name.into(), value.into());
        self
    }

    /// Why [`crate::Viewer::add`] would reject these options: an unknown extra or a bad style.
    pub fn problem(&self) -> Option<String> {
        if let Some(name) = self.extras.keys().find(|k| !EXTRAS.contains(&k.as_str())) {
            return Some(format!("unknown extra {name:?} (expected one of {})", EXTRAS.join(", ")));
        }
        self.style.problem()
    }
}

/// One object of the scene, as on the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Object {
    pub id: String,
    pub geom: Geom,
    pub label: Option<String>,
    pub group: Option<String>,
    /// The lesson step it belongs to; `None` shows in every step.
    pub step: Option<String>,
    /// Absent on notes, which have no style.
    pub style: Option<Style>,
    pub extras: Map<String, Value>,
}

impl Object {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("geom".into(), self.geom.to_json());
        if let Some(label) = &self.label {
            m.insert("label".into(), json!(label));
        }
        if let Some(group) = &self.group {
            m.insert("group".into(), json!(group));
        }
        if let Some(step) = &self.step {
            m.insert("step".into(), json!(step));
        }
        if let Some(style) = &self.style {
            m.insert("style".into(), style.to_json());
        }
        if !self.extras.is_empty() {
            m.insert("extras".into(), Value::Object(self.extras.clone()));
        }
        Value::Object(m)
    }
}

/// `P` → `P₃`; a label that already ends in a subscript gets a comma, `P₁` → `P₁,₃`
/// (the Python client's `indexed`).
pub fn indexed(label: &str, i: usize) -> String {
    const DIGITS: [char; 10] = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];
    let sub: String = i.to_string().chars().map(|c| DIGITS[c.to_digit(10).unwrap() as usize]).collect();
    if label.chars().last().is_some_and(|c| DIGITS.contains(&c)) {
        format!("{label},{sub}")
    } else {
        format!("{label}{sub}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Frame, NoteLevel};

    #[test]
    fn object_matches_the_protocol() {
        let obj = Object {
            id: "E".into(),
            geom: Geom::ellipse(Frame::WORLD, 3.0, 2.0),
            label: Some("E".into()),
            group: Some("conics".into()),
            step: None,
            style: Some(Style::new().color("#d1495b").width(3.0).dashed(false).opacity(1.0)),
            extras: Opts::new().extra("foci", true).extras,
        };
        assert_eq!(
            obj.to_json(),
            json!({
                "id": "E", "label": "E", "group": "conics",
                "geom": {"type": "ellipse", "a": 3.0, "b": 2.0,
                         "frame": {"o": [0.0, 0.0, 0.0], "x": [1.0, 0.0, 0.0], "y": [0.0, 1.0, 0.0], "z": [0.0, 0.0, 1.0]}},
                "style": {"color": "#d1495b", "width": 3.0, "dashed": false, "opacity": 1.0},
                "extras": {"foci": true}
            })
        );
    }

    #[test]
    fn optional_fields_are_left_out() {
        let note = Object {
            id: "n".into(),
            geom: Geom::note("∅", NoteLevel::Info),
            label: None,
            group: None,
            step: None,
            style: None,
            extras: Map::new(),
        };
        assert_eq!(note.to_json(), json!({"id": "n", "geom": {"type": "note", "text": "∅", "level": "info"}}));
    }

    #[test]
    fn opts_merge_style_and_check_extras() {
        let opts = Opts::new().color("red").width(2.0).style(Style::new().width(4.0));
        assert_eq!(opts.style, Style::new().color("red").width(4.0));
        assert_eq!(opts.problem(), None);
        assert!(Opts::new().extra("focus", true).problem().unwrap().starts_with("unknown extra \"focus\""));
        assert!(Opts::new().opacity(1.5).problem().unwrap().contains("opacity"));
        assert!(Opts::new().width(f64::NAN).problem().unwrap().contains("width"));
    }

    #[test]
    fn indexed_labels_match_python() {
        assert_eq!(indexed("P", 3), "P₃");
        assert_eq!(indexed("P", 13), "P₁₃");
        assert_eq!(indexed("P₁", 3), "P₁,₃");
    }
}
