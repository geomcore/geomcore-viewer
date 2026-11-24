# API and protocol

| Goal | Python | Rust |
| --- | --- | --- |
| Start a scene | `Viewer(title, view="2d")` | `Viewer::builder(title).view(ViewMode::Plane).build()?` |
| Add an object | `view.add(obj, label="A")` | `view.add(obj, Opts::new().label("A"))?` |
| Update or remove it | `handle.update(color="red")`, `handle.remove()` | `view.update(&handle, Style::new().color("red"))`, `view.remove(&handle)` |
| Send one update | `with view.batch():` | `view.batch(\|v\| { /* add objects */ Ok(()) })?` |
| Save for sharing | `view.save("scene.json")` | `view.save("scene.json")?` |

- [Python API and examples](https://github.com/geomcore/geomcore-viewer#api)
- [Rust client API on docs.rs](https://docs.rs/geomcore-viewer/)
- [Scene protocol v2](https://github.com/geomcore/geomcore-viewer/blob/main/protocol/SCENE.md)
- [Repository and local development](https://github.com/geomcore/geomcore-viewer#development)
