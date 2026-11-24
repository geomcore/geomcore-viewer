# API and protocol

## Python

- Create a scene with `Viewer(title, view="2d")`.
- Add an object with `view.add(obj, label="A")`.
- Change or remove it with `handle.update(color="red")` or `handle.remove()`.
- Send several changes together with `with view.batch():`.
- Export the scene with `view.save("scene.json")`.

See the [Python API and examples](https://github.com/geomcore/geomcore-viewer#api) for geometry types and styling options.

## Rust

- Choose a view with `Viewer::builder(title).view(ViewMode::Plane).build()?`.
- Add an object with `view.add(obj, Opts::new().label("A"))?`.
- Change or remove it with `view.update(&handle, style)` or `view.remove(&handle)`.
- Pass a closure to `view.batch(...)?` to send its updates together.
- Export the scene with `view.save("scene.json")?`.

Find signatures and supported types in the [Rust API reference](https://docs.rs/geomcore-viewer/).

## Scene protocol

The clients and viewer exchange [scene protocol v2](https://github.com/geomcore/geomcore-viewer/blob/main/protocol/SCENE.md) JSON. The specification describes scene metadata, geometry types, styling, and the local server endpoints.
