# Share scenes

## Save and open a scene

Call `view.save("scene.json")` in either client. To generate the file without opening a browser in Python, create the viewer with `Viewer("My scene", spawn=False)` before adding the geometry.

Open the [hosted viewer](https://geomcore.github.io/geomcore-viewer/) and drop the JSON file onto the page. To share a link, host the file and pass its URL in the `scene` query parameter. If the file is on another origin, its server must allow cross-origin requests from the viewer.

## Embed a scene

```html
<iframe
  src="https://geomcore.github.io/geomcore-viewer/?scene=https%3A%2F%2Fexample.org%2Fscene.json"
  title="Intersection of two curves"
  width="100%"
  height="540"
  loading="lazy"
  allowfullscreen>
</iframe>
```

Give the iframe a title that describes the geometry. URL-encode the scene URL, particularly if it contains its own query parameters.

## Use the local server from another machine

The server listens on loopback. To view a scene from a remote machine over SSH, forward the remote port and use the same port locally.

```sh
ssh -L 8765:127.0.0.1:8765 user@remote
```

Open `http://127.0.0.1:8765` on your machine. To use a different port, set `GEOMCORE_VIEWER_URL` in the environment that runs the client and forward that port.
