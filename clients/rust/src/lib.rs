//! Rust client for `geomcore-viewer`: show geometry live in the browser viewer
//! (scene protocol v2, `protocol/SCENE.md`).
//!
//! Objects are sent to the local viewer server over plain HTTP (`std` only, no
//! HTTP client dependency). The server is Python's: start it with
//! `python -m geomcore_viewer serve`. With the `geomcore` cargo feature,
//! geomcore's curves, surfaces and points convert to [`Geom`] directly.
//!
//! ```no_run
//! use geomcore_viewer::{Frame, Geom, Opts, Viewer};
//!
//! let mut view = Viewer::new("Ellipse and circle")?;
//! view.add(Geom::ellipse(Frame::WORLD, 3.0, 2.0), Opts::new().label("E").extra("foci", true))?;
//! # Ok::<(), geomcore_viewer::Error>(())
//! ```

mod geom;
mod http;
mod object;
mod viewer;

#[cfg(feature = "geomcore")]
mod convert;

pub use geom::{Frame, Geom, NoteLevel, Vec3, Window, COLORMAPS};
pub use object::{indexed, Object, Opts, Style, EXTRAS, PALETTE};
pub use viewer::{Builder, Error, Handle, Step, ViewMode, Viewer, DEFAULT_URL, URL_ENV};
