//! A live scene in the browser viewer (the Python client's `Viewer`, minus spawning).

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, TAU};
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::geom::{norm, Geom, NoteLevel};
use crate::http::{self, Endpoint, Probe};
use crate::object::{indexed, Object, Opts, Style, PALETTE};

/// The server URL when neither [`Builder::url`] nor `$GEOMCORE_VIEWER_URL` gives one.
pub const DEFAULT_URL: &str = "http://127.0.0.1:8765";
/// Overrides [`DEFAULT_URL`], as for the Python client.
pub const URL_ENV: &str = "GEOMCORE_VIEWER_URL";
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a probe that nothing answered suppresses the next one: adds keep
/// buffering without each waiting out the full timeout again.
const PROBE_COOLDOWN: Duration = Duration::from_secs(1);

/// Which view the page opens: `Auto` (the plane view when everything lies in z = 0),
/// `Plane` (2D) or `Space` (3D).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ViewMode {
    #[default]
    Auto,
    Plane,
    Space,
}

impl ViewMode {
    fn as_str(self) -> &'static str {
        match self {
            ViewMode::Auto => "auto",
            ViewMode::Plane => "2d",
            ViewMode::Space => "3d",
        }
    }
}

/// Everything that can go wrong. An unreachable server is not an error: the
/// viewer warns once on stderr and keeps the objects ([`Viewer::save`] still works).
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// The geometry, style or options would be rejected; nothing was changed.
    Invalid(String),
    /// The server URL is malformed.
    Url(String),
    /// The server answered with an error status.
    Rejected { status: u16, message: String },
    /// Writing a scene file failed.
    Io(std::io::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Invalid(msg) | Error::Url(msg) => f.write_str(msg),
            Error::Rejected { status, message } => {
                write!(f, "geomcore-viewer rejected the request ({status}): {message}")
            }
            Error::Io(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Error {
        Error::Io(err)
    }
}

/// One object in the scene, as returned by [`Viewer::add`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Handle {
    id: String,
}

impl Handle {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Options for a new [`Viewer`]; see [`Viewer::builder`].
#[derive(Debug, Clone)]
pub struct Builder {
    title: String,
    view: ViewMode,
    keep: bool,
    url: Option<String>,
}

impl Builder {
    pub fn view(mut self, view: ViewMode) -> Builder {
        self.view = view;
        self
    }
    /// Add to the scene already on the page instead of replacing it.
    pub fn keep(mut self, keep: bool) -> Builder {
        self.keep = keep;
        self
    }
    /// The server, e.g. `http://127.0.0.1:8799` (default: `$GEOMCORE_VIEWER_URL`, else [`DEFAULT_URL`]).
    pub fn url(mut self, url: &str) -> Builder {
        self.url = Some(url.into());
        self
    }
    pub fn build(self) -> Result<Viewer, Error> {
        let url = self.url.unwrap_or_else(default_url).trim_end_matches('/').to_string();
        let endpoint = Endpoint::parse(&url).map_err(Error::Url)?;
        Ok(Viewer {
            title: self.title,
            view: self.view,
            keep: self.keep,
            url,
            endpoint,
            run: run_id(),
            objects: Vec::new(),
            families: HashMap::new(),
            unsent: Vec::new(),
            pending_removals: Vec::new(),
            pending_clear: false,
            run_sent: false,
            resync: false,
            online: false,
            warned: false,
            warnings: Vec::new(),
            last_unanswered: None,
            next_color: 0,
            next_auto: 0,
        })
    }
}

/// `$GEOMCORE_VIEWER_URL` when set and not blank, else [`DEFAULT_URL`].
fn default_url() -> String {
    std::env::var(URL_ENV)
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_URL.into())
}

/// 12 hex digits, different for every viewer (std's randomly keyed hasher over time and pid).
fn run_id() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    h.write_u32(std::process::id());
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

/// A live scene in the browser viewer.
///
/// Every [`add`](Viewer::add) appears at once in the open tab. A new `Viewer`
/// (re-running a program) starts a new *run*: the tab swaps to it on its first
/// object unless [`Builder::keep`] is set. Rust never starts the server: run
/// `python -m geomcore_viewer serve` (or any Python script using the viewer).
///
/// ```no_run
/// use geomcore_viewer::{Frame, Geom, Opts, Viewer};
///
/// let mut view = Viewer::new("Ellipse and circle")?;
/// view.add(Geom::ellipse(Frame::WORLD, 3.0, 2.0), Opts::new().label("E").extra("foci", true))?;
/// view.add(Geom::circle(Frame::at([1.0, 0.0, 0.0]), 2.0), Opts::new().label("C"))?;
/// view.save("scene.json")?;
/// # Ok::<(), geomcore_viewer::Error>(())
/// ```
#[derive(Debug)]
pub struct Viewer {
    title: String,
    view: ViewMode,
    keep: bool,
    url: String,
    endpoint: Endpoint,
    run: String,
    objects: Vec<Object>,
    families: HashMap<String, Vec<String>>, // label → ids its last add produced
    unsent: Vec<String>,
    pending_removals: Vec<String>, // deletes the server has not acknowledged yet
    pending_clear: bool,
    run_sent: bool, // this run has reached a server at least once
    resync: bool,   // the server may have lost our scene: re-send everything
    online: bool,
    warned: bool,
    warnings: Vec<String>,
    last_unanswered: Option<Instant>, // a probe that nothing answered: skip re-probing for a while
    next_color: usize,
    next_auto: usize,
}

impl Viewer {
    /// A viewer with the default options: the URL from `$GEOMCORE_VIEWER_URL`, `ViewMode::Auto`.
    pub fn new(title: &str) -> Result<Viewer, Error> {
        Viewer::builder(title).build()
    }

    pub fn builder(title: &str) -> Builder {
        Builder { title: title.into(), view: ViewMode::Auto, keep: false, url: None }
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// This viewer's run id.
    pub fn run(&self) -> &str {
        &self.run
    }

    /// The objects in the scene, in the order they were first added.
    pub fn objects(&self) -> &[Object] {
        &self.objects
    }

    // -- adding --------------------------------------------------------------

    /// Show one geometry: a [`Geom`], or with the `geomcore` feature any geomcore
    /// curve, surface or point. A labelled object's id is its label, so re-adding a
    /// label replaces what it showed; an unlabelled one gets a fresh id.
    pub fn add(&mut self, geom: impl Into<Geom>, opts: Opts) -> Result<Handle, Error> {
        let label = opts.label.clone();
        let mut handles = self.commit(vec![(label.clone(), geom.into())], label, &opts)?;
        Ok(handles.remove(0))
    }

    /// Show several geometries under one label: `P` becomes `P₁`, `P₂`, … (the
    /// way the Python client shows an intersection's points). An empty list shows
    /// the note `P: ∅`.
    pub fn add_all<G: Into<Geom>>(
        &mut self,
        geoms: impl IntoIterator<Item = G>,
        opts: Opts,
    ) -> Result<Vec<Handle>, Error> {
        let geoms: Vec<Geom> = geoms.into_iter().map(Into::into).collect();
        let label = opts.label.clone();
        let parts = if geoms.is_empty() {
            let text = label.as_ref().map_or("∅".into(), |l| format!("{l}: ∅"));
            vec![(label.as_ref().map(|l| format!("{l}·note")), Geom::note(&text, NoteLevel::Info))]
        } else if geoms.len() == 1 {
            vec![(label.clone(), geoms.into_iter().next().unwrap())]
        } else {
            geoms.into_iter().enumerate().map(|(i, g)| (label.as_ref().map(|l| indexed(l, i + 1)), g)).collect()
        };
        self.commit(parts, label, &opts)
    }

    /// Show a curve of `on`'s (u, v) parameter space: a `Line`, `Circle` or
    /// `Polyline` whose x, y are u, v — with the `geomcore` feature, what
    /// `parametrize_on` returns. The viewer draws it on the surface in 3D and in
    /// the (u, v) pane.
    pub fn pcurve(&mut self, curve: impl Into<Geom>, on: &Handle, opts: Opts) -> Result<Handle, Error> {
        match self.objects.iter().find(|o| o.id == on.id) {
            Some(o) if o.geom.is_surface() => {}
            _ => return Err(Error::Invalid(format!("{}: a pcurve needs a surface of this scene", on.id))),
        }
        let geom = Geom::Pcurve { surface: on.id.clone(), curve: Box::new(curve.into()) };
        self.add(geom, opts)
    }

    fn commit(
        &mut self,
        parts: Vec<(Option<String>, Geom)>,
        family: Option<String>,
        opts: &Opts,
    ) -> Result<Vec<Handle>, Error> {
        if let Some(problem) = opts.problem() {
            return Err(Error::Invalid(problem));
        }
        if let Some(problem) = parts.iter().find_map(|(id, g)| g.problem().map(|p| (id, p))) {
            return Err(Error::Invalid(match problem {
                (Some(id), p) => format!("{id}: {p}"),
                (None, p) => p,
            }));
        }
        let mut built = Vec::new();
        for (id, geom) in parts {
            let id = id.unwrap_or_else(|| self.auto_id());
            built.push(self.build(id, geom, opts));
        }
        let ids: Vec<String> = built.iter().map(|o| o.id.clone()).collect();
        for obj in built {
            self.unsent.push(obj.id.clone());
            match self.objects.iter_mut().find(|o| o.id == obj.id) {
                Some(slot) => *slot = obj,
                None => self.objects.push(obj),
            }
        }
        if let Some(label) = family {
            for stale in self.families.remove(&label).unwrap_or_default() {
                if !ids.contains(&stale) {
                    self.forget(&stale);
                }
            }
            self.families.insert(label, ids.clone());
        }
        self.flush()?;
        Ok(ids.into_iter().map(|id| Handle { id }).collect())
    }

    fn build(&mut self, id: String, mut geom: Geom, opts: &Opts) -> Object {
        if geom.is_surface() {
            let extent = scene_extent(self.objects.iter().filter(|o| o.id != id).map(|o| &o.geom));
            fill_window(&mut geom, extent);
        }
        let style = match geom {
            Geom::Note { .. } => None,
            _ => {
                let previous = self
                    .objects
                    .iter()
                    .find(|o| o.id == id)
                    .and_then(|o| o.style.as_ref())
                    .and_then(|s| s.color.clone());
                let color = previous.unwrap_or_else(|| self.next_color());
                Some(Style::new().color(&color).merged(&opts.style))
            }
        };
        let label = match geom {
            Geom::Note { .. } => None,
            _ => opts.label.as_ref().map(|_| id.clone()),
        };
        Object { id, geom, label, group: opts.group.clone(), style, extras: opts.extras.clone() }
    }

    fn next_color(&mut self) -> String {
        let color = PALETTE[self.next_color % PALETTE.len()];
        self.next_color += 1;
        color.into()
    }

    fn auto_id(&mut self) -> String {
        self.next_auto += 1;
        format!("{}-{}", &self.run[..6], self.next_auto)
    }

    // -- changing and removing ---------------------------------------------------

    /// Change `color`, `width`, `dashed` or `opacity` in place.
    pub fn update(&mut self, handle: &Handle, style: Style) -> Result<(), Error> {
        if let Some(problem) = style.problem() {
            return Err(Error::Invalid(problem));
        }
        let obj = self
            .objects
            .iter_mut()
            .find(|o| o.id == handle.id)
            .ok_or_else(|| Error::Invalid(format!("{:?} is no longer in the scene", handle.id)))?;
        obj.style = Some(obj.style.clone().unwrap_or_default().merged(&style));
        self.unsent.push(handle.id.clone());
        self.flush()
    }

    pub fn remove(&mut self, handle: &Handle) -> Result<(), Error> {
        self.forget(&handle.id);
        self.flush()
    }

    /// Drop an object here and queue its deletion on the server (sent by `flush`).
    fn forget(&mut self, id: &str) {
        self.objects.retain(|o| o.id != id);
        self.unsent.retain(|i| i != id);
        if self.run_sent {
            self.pending_removals.push(id.into());
        }
    }

    /// Empty the scene, here and in the open tab.
    pub fn clear(&mut self) -> Result<(), Error> {
        self.objects.clear();
        self.families.clear();
        self.unsent.clear();
        self.pending_removals.clear();
        self.pending_clear = true;
        self.flush()
    }

    // -- persistence ---------------------------------------------------------------

    /// The scene document (`protocol/SCENE.md`).
    pub fn scene(&self) -> Value {
        json!({
            "version": http::PROTOCOL,
            "title": self.title,
            "run": self.run,
            "view": self.view.as_str(),
            "objects": self.objects.iter().map(Object::to_json).collect::<Vec<_>>(),
        })
    }

    /// Write the scene as JSON (open it with `?scene=` or drag-drop it on the page).
    pub fn save(&self, path: impl AsRef<Path>) -> Result<PathBuf, Error> {
        let path = path.as_ref().to_path_buf();
        std::fs::write(&path, self.scene().to_string())?;
        Ok(path)
    }

    // -- transport -------------------------------------------------------------------

    /// Bring the server up to date: pending clear, then deletes, then upserts.
    fn flush(&mut self) -> Result<(), Error> {
        if (self.unsent.is_empty() && self.pending_removals.is_empty() && !self.pending_clear) || !self.connect() {
            return Ok(());
        }
        if self.pending_clear {
            self.pending_clear = false;
            if !self.send("POST", "/api/clear", Some(json!({})), false)? {
                self.pending_clear = true;
                return Ok(());
            }
        }
        while !self.pending_removals.is_empty() {
            let id = self.pending_removals.remove(0);
            match self.send("DELETE", &format!("/api/objects/{}", encode(&id)), None, true)? {
                true => {}
                false => {
                    // Unreachable: put the id back so the delete goes out once the server is back.
                    // A rejection (Err) already took it off the queue, so it cannot block later ops.
                    self.pending_removals.insert(0, id);
                    return Ok(());
                }
            }
        }
        if self.unsent.is_empty() {
            return Ok(());
        }
        let mut ids: Vec<String> = Vec::new();
        for id in &self.unsent {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let objects: Vec<Value> =
            ids.iter().filter_map(|id| self.objects.iter().find(|o| &o.id == id)).map(Object::to_json).collect();
        let mut batch = json!({"objects": objects, "title": self.title, "view": self.view.as_str()});
        if self.resync || !self.run_sent {
            batch["run"] = json!(self.run);
            batch["keep"] = json!(self.keep);
        }
        match self.send("POST", "/api/objects", Some(batch), false) {
            Ok(true) => {
                self.run_sent = true;
                self.resync = false;
                self.unsent.clear();
                Ok(())
            }
            Ok(false) => Ok(()),
            Err(err) => {
                // A rejected batch must not block every later add.
                self.unsent.retain(|i| !ids.contains(i));
                Err(err)
            }
        }
    }

    fn connect(&mut self) -> bool {
        if self.online {
            return true;
        }
        if let Some(t) = self.last_unanswered {
            if t.elapsed() < PROBE_COOLDOWN {
                return false; // nothing answered a moment ago: keep buffering without another 0.5 s wait
            }
        }
        let keeping = "keeping objects locally (save() still works)";
        match http::probe(&self.endpoint, PROBE_TIMEOUT) {
            Probe::Ours => {
                self.online = true;
                self.warned = false; // a later outage deserves its own warning
                self.last_unanswered = None;
            }
            Probe::Refused => self.warn(format!("{}; {keeping}", http::refused_hint(&self.url, self.endpoint.port))),
            Probe::Foreign => {
                self.warn(format!("{} answers but is not a geomcore-viewer v2 server; {keeping}", self.url))
            }
            Probe::Unresponsive => {
                self.last_unanswered = Some(Instant::now());
                self.warn(format!("{} accepted the connection but did not answer in time; {keeping}", self.url))
            }
            Probe::Nothing => self.warn(format!(
                "no geomcore-viewer at {}: start one with `python -m geomcore_viewer serve --port {}`; {keeping}",
                self.url, self.endpoint.port
            )),
        }
        self.online
    }

    /// `Ok(true)` when the server took the request, `Ok(false)` when it could not be
    /// reached (the whole scene goes out again once it is back), `Err` when it said no.
    fn send(&mut self, method: &str, path: &str, body: Option<Value>, missing_ok: bool) -> Result<bool, Error> {
        let body = body.map(|b| b.to_string());
        match http::request(&self.endpoint, method, path, body.as_deref(), REQUEST_TIMEOUT) {
            Ok(res) if res.status < 300 || (missing_ok && res.status == 404) => Ok(true),
            Ok(res) => Err(Error::Rejected { status: res.status, message: format!("{method} {path}: {}", res.body) }),
            Err(err) => {
                self.online = false;
                self.resync = self.run_sent;
                self.unsent = self.objects.iter().map(|o| o.id.clone()).collect();
                self.warn(format!("geomcore-viewer at {} is unreachable ({err}); keeping objects locally", self.url));
                Ok(false)
            }
        }
    }

    fn warn(&mut self, message: String) {
        if !self.warned {
            self.warned = true;
            eprintln!("geomcore-viewer: {message}");
            self.warnings.push(message);
        }
    }
}

/// Percent-encode an id for a URL path (everything but unreserved ASCII).
fn encode(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Half-size for infinite surface windows: 1.5 × the farthest finite feature from
/// the origin, or 5 for an empty scene (the Python client's `scene_extent`).
fn scene_extent<'a>(geoms: impl Iterator<Item = &'a Geom>) -> f64 {
    let mut reach: f64 = 0.0;
    for g in geoms {
        reach = reach.max(match g {
            Geom::Point { p } => norm(*p),
            Geom::Circle { frame, r, .. } | Geom::Sphere { frame, r, .. } => norm(frame.o) + r,
            Geom::Ellipse { frame, a, .. } => norm(frame.o) + a,
            Geom::Torus { frame, major, minor, .. } => norm(frame.o) + major + minor,
            Geom::Polyline { points } => points.iter().map(|p| norm(*p)).fold(0.0, f64::max),
            Geom::Mesh { vertices, .. } => vertices.iter().map(|p| norm(*p)).fold(0.0, f64::max),
            Geom::Box { min, max } => norm(*min).max(norm(*max)),
            _ => 0.0,
        });
    }
    if reach > 0.0 {
        1.5 * reach
    } else {
        5.0
    }
}

/// Fill what a surface's window leaves out: full periods, else ± `extent`.
fn fill_window(geom: &mut Geom, extent: f64) {
    let infinite = [-extent, extent];
    let (u, v) = match geom {
        Geom::Plane { .. } => (infinite, infinite),
        Geom::Cylinder { .. } | Geom::Cone { .. } => ([0.0, TAU], infinite),
        Geom::Sphere { .. } => ([0.0, TAU], [-FRAC_PI_2, FRAC_PI_2]),
        Geom::Torus { .. } => ([0.0, TAU], [0.0, TAU]),
        _ => return,
    };
    if let Some(w) = geom.window_mut() {
        w.u.get_or_insert(u);
        w.v.get_or_insert(v);
    }
}

#[cfg(test)]
impl Viewer {
    pub(crate) fn warnings(&self) -> &[String] {
        &self.warnings
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Frame, Window};
    use crate::http::stub;

    fn viewer(port: u16) -> Viewer {
        Viewer::builder("t").url(&format!("http://127.0.0.1:{port}")).build().unwrap()
    }

    fn posted(seen: &stub::Seen) -> Vec<Value> {
        let seen = seen.lock().unwrap();
        seen.iter()
            .filter(|(m, p, _)| m == "POST" && p == "/api/objects")
            .map(|(_, _, b)| serde_json::from_str(b).unwrap())
            .collect()
    }

    fn requests(seen: &stub::Seen) -> Vec<String> {
        seen.lock().unwrap().iter().map(|(m, p, _)| format!("{m} {p}")).collect()
    }

    #[test]
    fn run_ids_are_twelve_hex_digits_and_differ() {
        let (a, b) = (run_id(), run_id());
        assert_eq!(a.len(), 12);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn the_first_batch_starts_the_run() {
        let (port, seen) = stub::viewer();
        let mut v = Viewer::builder("Conics")
            .view(ViewMode::Plane)
            .keep(true)
            .url(&format!("http://127.0.0.1:{port}/"))
            .build()
            .unwrap();
        assert_eq!(v.url(), format!("http://127.0.0.1:{port}"));
        v.add(Geom::point([1.0, 2.0, 0.0]), Opts::new().label("P")).unwrap();
        v.add(Geom::point([3.0, 0.0, 0.0]), Opts::new()).unwrap();
        assert_eq!(requests(&seen), ["GET /api/health", "POST /api/objects", "POST /api/objects"]);
        let batches = posted(&seen);
        assert_eq!(batches[0]["run"], json!(v.run()));
        assert_eq!(batches[0]["keep"], json!(true));
        assert_eq!((&batches[0]["title"], &batches[0]["view"]), (&json!("Conics"), &json!("2d")));
        assert_eq!(
            batches[0]["objects"][0],
            json!({"id": "P", "label": "P", "geom": {"type": "point", "p": [1.0, 2.0, 0.0]}, "style": {"color": PALETTE[0]}})
        );
        assert!(batches[1].get("run").is_none());
        assert_eq!(batches[1]["objects"][0]["id"], json!(format!("{}-1", &v.run()[..6])));
        assert_eq!(batches[1]["objects"][0]["style"]["color"], json!(PALETTE[1]));
    }

    #[test]
    fn re_adding_a_label_replaces_what_it_showed() {
        let (port, seen) = stub::viewer();
        let mut v = viewer(port);
        let hs = v.add_all([Geom::point([0.0; 3]), Geom::point([1.0, 0.0, 0.0])], Opts::new().label("P")).unwrap();
        assert_eq!(hs.iter().map(Handle::id).collect::<Vec<_>>(), ["P₁", "P₂"]);
        let h = v.add(Geom::point([2.0, 0.0, 0.0]), Opts::new().label("P").color("#000000")).unwrap();
        assert_eq!(h.id(), "P");
        assert_eq!(v.objects().iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["P"]);
        assert_eq!(
            requests(&seen)[2..],
            ["DELETE /api/objects/P%E2%82%81", "DELETE /api/objects/P%E2%82%82", "POST /api/objects"]
        );
        assert_eq!(v.objects()[0].style.as_ref().unwrap().color.as_deref(), Some("#000000"));
    }

    #[test]
    fn an_empty_list_shows_a_note() {
        let (port, _) = stub::viewer();
        let mut v = viewer(port);
        let hs = v.add_all(Vec::<Geom>::new(), Opts::new().label("I")).unwrap();
        assert_eq!(hs[0].id(), "I·note");
        assert_eq!(
            v.scene()["objects"][0],
            json!({"id": "I·note", "geom": {"type": "note", "text": "I: ∅", "level": "info"}})
        );
    }

    #[test]
    fn re_adding_an_id_keeps_its_colour_and_place() {
        let (port, _) = stub::viewer();
        let mut v = viewer(port);
        v.add(Geom::point([0.0; 3]), Opts::new().label("A")).unwrap();
        v.add(Geom::point([0.0; 3]), Opts::new().label("B")).unwrap();
        v.add(Geom::point([1.0; 3]), Opts::new().label("A")).unwrap();
        let ids: Vec<_> = v.objects().iter().map(|o| (o.id.clone(), o.style.clone().unwrap().color.unwrap())).collect();
        assert_eq!(ids, [("A".to_string(), PALETTE[0].to_string()), ("B".to_string(), PALETTE[1].to_string())]);
    }

    #[test]
    fn surfaces_get_a_window_from_the_scene() {
        let (port, _) = stub::viewer();
        let mut v = viewer(port);
        let s = v.add(Geom::sphere(Frame::WORLD, 1.0), Opts::new().label("S")).unwrap();
        v.add(Geom::circle(Frame::at([0.0, 0.0, 1.0]), 2.0), Opts::new()).unwrap();
        v.add(Geom::cylinder(Frame::WORLD, 2.0).window(None, Some([-1.0, 1.0])), Opts::new().label("Z")).unwrap();
        v.add(Geom::plane(Frame::WORLD), Opts::new().label("P")).unwrap();
        let window =
            |id: &str| v.objects().iter().find(|o| o.id == id).unwrap().geom.clone().window_mut().copied().unwrap();
        assert_eq!(window(s.id()), Window { u: Some([0.0, TAU]), v: Some([-FRAC_PI_2, FRAC_PI_2]) });
        assert_eq!(window("Z"), Window { u: Some([0.0, TAU]), v: Some([-1.0, 1.0]) });
        let half = 1.5 * (1.0 + 2.0); // the circle reaches |o| + r = 3
        assert_eq!(window("P"), Window { u: Some([-half, half]), v: Some([-half, half]) });
    }

    #[test]
    fn update_remove_and_clear_reach_the_server() {
        let (port, seen) = stub::viewer();
        let mut v = viewer(port);
        let h = v.add(Geom::point([0.0; 3]), Opts::new().label("A").width(3.0)).unwrap();
        v.update(&h, Style::new().color("#123456")).unwrap();
        assert_eq!(posted(&seen)[1]["objects"][0]["style"], json!({"color": "#123456", "width": 3.0}));
        v.remove(&h).unwrap();
        assert!(
            matches!(v.update(&h, Style::new().width(1.0)), Err(Error::Invalid(m)) if m.contains("no longer in the scene"))
        );
        v.add(Geom::point([0.0; 3]), Opts::new()).unwrap();
        v.clear().unwrap();
        assert!(v.objects().is_empty());
        assert_eq!(requests(&seen)[3..], ["DELETE /api/objects/A", "POST /api/objects", "POST /api/clear"]);
    }

    #[test]
    fn invalid_input_changes_nothing() {
        let (port, seen) = stub::viewer();
        let mut v = viewer(port);
        let err = v.add(Geom::circle(Frame::WORLD, -1.0), Opts::new().label("C")).unwrap_err();
        assert_eq!(err.to_string(), "C: circle.r must be positive");
        assert!(matches!(v.add(Geom::point([0.0; 3]), Opts::new().extra("focus", true)), Err(Error::Invalid(_))));
        assert!(matches!(v.add(Geom::point([f64::NAN, 0.0, 0.0]), Opts::new()), Err(Error::Invalid(_))));
        assert!(v.objects().is_empty());
        assert!(requests(&seen).is_empty());
    }

    #[test]
    fn a_rejected_batch_is_an_error_but_does_not_block_later_adds() {
        let (port, seen) = stub::serve(|_, path, body| match path {
            "/api/health" => (200, r#"{"app": "geomcore-viewer", "protocol": 2}"#.into()),
            _ if body.contains("\"bad\"") => (400, r#"{"error": "no"}"#.into()),
            _ => (200, "{}".into()),
        });
        let mut v = viewer(port);
        let err = v.add(Geom::point([0.0; 3]), Opts::new().label("bad")).unwrap_err();
        assert!(
            matches!(&err, Error::Rejected { status: 400, message } if message.contains(r#"{"error": "no"}"#)),
            "{err}"
        );
        v.add(Geom::point([0.0; 3]), Opts::new().label("good")).unwrap();
        let last = posted(&seen).pop().unwrap();
        assert_eq!(last["objects"].as_array().unwrap().len(), 1);
        assert_eq!(last["objects"][0]["id"], json!("good"));
    }

    #[test]
    fn a_rejected_delete_does_not_block_later_adds() {
        let (port, seen) = stub::serve(|method, path, _| match (method, path) {
            (_, "/api/health") => (200, r#"{"app": "geomcore-viewer", "protocol": 2}"#.into()),
            ("DELETE", _) => (500, r#"{"error": "a proxy said no"}"#.into()),
            _ => (200, "{}".into()),
        });
        let mut v = viewer(port);
        let h = v.add(Geom::point([0.0; 3]), Opts::new().label("A")).unwrap();
        let err = v.remove(&h).unwrap_err();
        assert!(matches!(&err, Error::Rejected { status: 500, .. }), "{err}");
        v.add(Geom::point([1.0; 3]), Opts::new().label("B")).unwrap();
        assert_eq!(
            requests(&seen),
            ["GET /api/health", "POST /api/objects", "DELETE /api/objects/A", "POST /api/objects"]
        );
        let last = posted(&seen).pop().unwrap();
        assert_eq!(last["objects"].as_array().unwrap().len(), 1);
        assert_eq!(last["objects"][0]["id"], json!("B"));
    }

    #[test]
    fn adds_against_a_server_that_never_answers_do_not_each_wait_out_the_probe() {
        use std::net::TcpListener;
        let hung = TcpListener::bind("127.0.0.1:0").unwrap(); // accepts (backlog) but never replies
        let port = hung.local_addr().unwrap().port();
        let mut v = viewer(port);
        let start = Instant::now();
        for i in 0..5 {
            v.add(Geom::point([i as f64, 0.0, 0.0]), Opts::new()).unwrap();
        }
        assert!(start.elapsed() < Duration::from_secs(2), "5 adds took {:?}", start.elapsed());
        assert_eq!(v.objects().len(), 5);
        assert_eq!(v.warnings().len(), 1);
    }

    #[test]
    fn without_a_server_objects_are_kept_and_one_warning_says_how_to_start_it() {
        let port = stub::closed_port();
        let mut v = viewer(port);
        v.add(Geom::point([0.0; 3]), Opts::new().label("A")).unwrap();
        v.add(Geom::point([1.0; 3]), Opts::new().label("B")).unwrap();
        assert_eq!(v.objects().len(), 2);
        assert_eq!(v.warnings().len(), 1);
        assert!(
            v.warnings()[0].contains(&format!("python -m geomcore_viewer serve --port {port}")),
            "{}",
            v.warnings()[0]
        );
        let path = std::env::temp_dir().join(format!("gv-{}.json", v.run()));
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(v.save(&path).unwrap()).unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(doc, v.scene());
        assert_eq!((doc["version"].clone(), doc["objects"].as_array().unwrap().len()), (json!(2), 2));
    }

    #[test]
    fn a_server_that_refuses_the_host_gets_the_tunnel_hint() {
        let (port, _) = stub::serve(|_, _, _| (403, r#"{"error": "no", "app": "geomcore-viewer"}"#.into()));
        let mut v = viewer(port);
        v.add(Geom::point([0.0; 3]), Opts::new()).unwrap();
        assert!(v.warnings()[0].contains(&format!("ssh -L {port}:127.0.0.1:{port}")), "{}", v.warnings()[0]);
    }

    #[test]
    fn a_server_that_comes_back_gets_the_whole_scene_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let probes = AtomicUsize::new(0);
        let (port, seen) = stub::serve(move |_, path, _| match path {
            // Foreign on the first probe: the viewer stays offline until the second.
            "/api/health" if probes.fetch_add(1, Ordering::SeqCst) == 0 => (404, "{}".into()),
            "/api/health" => (200, r#"{"app": "geomcore-viewer", "protocol": 2}"#.into()),
            _ => (200, "{}".into()),
        });
        let mut v = viewer(port);
        v.add(Geom::point([0.0; 3]), Opts::new().label("A")).unwrap();
        assert_eq!(v.warnings().len(), 1);
        v.add(Geom::point([1.0; 3]), Opts::new().label("B")).unwrap();
        let batch = posted(&seen).pop().unwrap();
        assert_eq!(batch["run"], json!(v.run()));
        assert_eq!(
            batch["objects"].as_array().unwrap().iter().map(|o| o["id"].clone()).collect::<Vec<_>>(),
            [json!("A"), json!("B")]
        );
    }

    #[test]
    fn pcurve_names_its_surface() {
        let (port, _) = stub::viewer();
        let mut v = viewer(port);
        let s = v.add(Geom::cylinder(Frame::WORLD, 2.0), Opts::new().label("S")).unwrap();
        let c = v.add(Geom::circle(Frame::WORLD, 2.0), Opts::new().label("C")).unwrap();
        let pc = v.pcurve(Geom::line([0.0, 3.0, 0.0], [1.0, 0.0, 0.0]), &s, Opts::new().label("C on S")).unwrap();
        let obj = v.scene()["objects"].as_array().unwrap().iter().find(|o| o["id"] == json!(pc.id())).unwrap().clone();
        assert_eq!(
            obj["geom"],
            json!({"type": "pcurve", "surface": "S", "curve": {"type": "line", "o": [0.0, 3.0, 0.0], "d": [1.0, 0.0, 0.0]}})
        );
        assert!(matches!(v.pcurve(Geom::line([0.0; 3], [1.0, 0.0, 0.0]), &c, Opts::new()), Err(Error::Invalid(_))));
        assert!(matches!(v.pcurve(Geom::ellipse(Frame::WORLD, 2.0, 1.0), &s, Opts::new()), Err(Error::Invalid(_))));
    }

    #[test]
    fn a_malformed_url_is_an_error() {
        assert!(matches!(Viewer::builder("t").url("http://127.0.0.1:x").build(), Err(Error::Url(_))));
    }

    /// `tests/scene.json` holds one object of every kind, as this client sends them;
    /// the viewer's own tests (`frontend/test/rust-scene.test.ts`) check it parses
    /// without problems. Regenerate it with `GV_UPDATE_FIXTURE=1 cargo test`.
    #[test]
    fn the_scene_fixture_is_current() {
        let (port, _) = stub::viewer();
        let mut v = Viewer::builder("Every kind")
            .view(ViewMode::Space)
            .url(&format!("http://127.0.0.1:{port}"))
            .build()
            .unwrap();
        let tilted = Frame::new([1.0, 0.0, 0.0], [0.0, 0.6, 0.8], [1.0, 0.0, 0.0]).unwrap();
        let o = || Opts::new();
        v.add(Geom::line([0.0; 3], [1.0, 1.0, 0.0]).range(-1.0, 1.0), o().label("line").dashed(true)).unwrap();
        v.add(Geom::circle(tilted, 1.0), o().label("circle").width(3.0)).unwrap();
        v.add(Geom::ellipse(Frame::WORLD, 3.0, 2.0), o().label("ellipse").extra("foci", true)).unwrap();
        v.add(Geom::parabola(Frame::WORLD, 0.5), o().label("parabola").extra("directrix", true)).unwrap();
        v.add(Geom::hyperbola(Frame::WORLD, 1.0, 0.5), o().label("hyperbola").extra("asymptotes", true)).unwrap();
        v.add(Geom::polyline(vec![[0.0; 3], [1.0, 2.0, 0.0], [2.0, 0.0, 1.0]]), o().label("polyline")).unwrap();
        v.add(Geom::plane(tilted), o().label("plane").opacity(0.4)).unwrap();
        let cyl = v.add(Geom::cylinder(Frame::WORLD, 2.0), o().label("cylinder").extra("isolines", [8, 4])).unwrap();
        v.add(Geom::cone(Frame::WORLD, 0.4, 0.0).window(None, Some([0.0, 2.0])), o().label("cone")).unwrap();
        v.add(Geom::sphere(Frame::at([0.0, 0.0, 3.0]), 1.0), o().label("sphere").extra("wire", true)).unwrap();
        v.add(Geom::torus(Frame::WORLD, 3.0, 0.5), o().label("torus").group("surfaces")).unwrap();
        v.add(Geom::mesh(vec![[0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], vec![0, 1, 2]), o().label("mesh")).unwrap();
        v.add(Geom::point([1.0, 2.0, 3.0]), o().label("point")).unwrap();
        v.add(Geom::Points { positions: vec![[0.0; 3], [1.0; 3]], size: Some(4.0) }, o().label("points")).unwrap();
        v.add(Geom::arrow([0.0; 3], [0.0, 0.0, 1.0]), o().label("arrow")).unwrap();
        v.add(Geom::text([0.0, 0.0, 1.0], "z"), o().label("text")).unwrap();
        v.add_all(Vec::<Geom>::new(), o().label("note")).unwrap();
        v.pcurve(Geom::line([0.0, 1.0, 0.0], [1.0, 0.0, 0.0]), &cyl, o().label("pcurve line")).unwrap();
        v.pcurve(Geom::circle(Frame::at([1.0, 0.0, 0.0]), 0.5), &cyl, o().label("pcurve circle")).unwrap();
        v.add(Geom::bbox([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]), o().label("box")).unwrap();
        v.add(
            Geom::bspline_curve(1, vec![[0.0; 3], [1.0, 2.0, 0.0]], None, vec![0.0, 1.0], vec![2, 2], false),
            o().label("bspline curve"),
        )
        .unwrap();
        v.add(
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
                false,
            ),
            o().label("bspline surface"),
        )
        .unwrap();
        let mut doc = v.scene();
        doc["run"] = json!("fixture");
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scene.json");
        let text = serde_json::to_string_pretty(&doc).unwrap() + "\n";
        if std::env::var_os("GV_UPDATE_FIXTURE").is_some() {
            std::fs::write(&path, &text).unwrap();
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "run GV_UPDATE_FIXTURE=1 cargo test");
    }
}
