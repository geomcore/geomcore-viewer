import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, StoreEvent } from "../src/store";

const pt = (id: string, x = 0) => ({ id, geom: { type: "point", p: [x, 0, 0] } });

function storeWith(...ids: string[]) {
  const store = new Store();
  store.reset({ version: 2, title: "", run: "r1", view: "auto", objects: ids.map((id) => pt(id) as never) });
  const events: StoreEvent["type"][] = [];
  store.onChange((ev) => events.push(ev.type));
  return { store, events };
}

const ids = (store: Store) => [...store.objects.keys()];

describe("Store.apply", () => {
  it("keeps the old scene until the new run's first upsert, then swaps", () => {
    const { store, events } = storeWith("a");
    store.apply({ type: "run", run: "r2", keep: false });
    expect(ids(store)).toEqual(["a"]);
    store.apply({ type: "upsert", objects: [pt("b")], title: "second", view: "3d" });
    expect(ids(store)).toEqual(["b"]);
    expect(store.title).toBe("second");
    expect(store.view).toBe("3d");
    expect(events).toEqual(["reset"]);
  });

  it("accumulates with keep and within a run", () => {
    const { store, events } = storeWith("a");
    store.apply({ type: "run", run: "r2", keep: true });
    store.apply({ type: "upsert", objects: [pt("b")] });
    store.apply({ type: "upsert", objects: [pt("a", 5)] });
    expect(ids(store)).toEqual(["a", "b"]);
    expect(store.objects.get("a")?.geom).toEqual({ type: "point", p: [5, 0, 0] });
    expect(events).toEqual(["upsert", "upsert"]);
  });

  it("records problems without dropping valid objects", () => {
    const { store } = storeWith();
    store.apply({ type: "upsert", objects: [pt("ok"), { id: "bad", geom: { type: "foo" } }] });
    expect(ids(store)).toEqual(["ok"]);
    expect(store.problems.get("bad")?.message).toBe('unknown type "foo"');
    store.apply({ type: "remove", id: "bad" });
    expect(store.problems.size).toBe(0);
  });

  it("removes and clears", () => {
    const { store, events } = storeWith("a", "b");
    store.apply({ type: "remove", id: "a" });
    store.apply({ type: "clear" });
    expect(ids(store)).toEqual([]);
    expect(events).toEqual(["remove", "reset"]);
  });

  it("forgets the steps when the page is cleared", () => {
    const { store } = storeWith("a");
    store.apply({ type: "upsert", objects: [], steps: ["one", "two"] });
    expect(store.steps).toEqual(["one", "two"]);
    store.apply({ type: "clear" });
    expect(store.steps).toEqual([]);
  });
});

describe("Store.loadUrl", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports HTTP failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    const store = new Store();
    await store.loadUrl("missing.json");
    expect(store.status).toBe("could not load missing.json (HTTP 404)");
    expect(store.problems.get("_doc")?.message).toBe("could not load missing.json (HTTP 404)");
  });

  it("reports documents that are not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>")));
    const store = new Store();
    await store.loadUrl("page.html");
    expect(store.status).toBe("could not load page.html (not JSON)");
  });

  it("reports unsupported versions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: 9, objects: [] })));
    const store = new Store();
    await store.loadUrl("future.json");
    expect(store.problems.get("_doc")?.message).toMatch(/unsupported scene version 9/);
  });
});

describe("Store.apply replacement", () => {
  it("drops the stale object when its replacement is invalid", () => {
    const { store, events } = storeWith("a");
    store.apply({ type: "upsert", objects: [{ id: "a", geom: { type: "foo" } }] });
    expect(store.objects.has("a")).toBe(false);
    expect(store.problems.has("a")).toBe(true);
    expect(events).toEqual(["reset"]);
  });
});

describe("Store.emit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("isolates a throwing handler: later handlers still run and the status shows the error", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new Store();
    const seen: StoreEvent["type"][] = [];
    store.onChange((ev) => {
      if (ev.type === "upsert") throw new Error("boom");
    });
    store.onChange((ev) => seen.push(ev.type));
    store.apply({ type: "upsert", objects: [pt("a")] });
    expect(seen).toContain("upsert");
    expect(store.status).toBe("render error: boom");
    expect(errors).toHaveBeenCalled();
  });

  it("does not recurse forever when a handler throws on every event", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new Store();
    store.onChange(() => {
      throw new Error("always");
    });
    expect(() => store.setStatus("x")).not.toThrow();
    expect(store.status).toBe("render error: always");
  });
});

describe("Store.load", () => {
  afterEach(() => vi.unstubAllGlobals());

  class NoopEventSource {
    static last: NoopEventSource | null = null;
    onmessage: ((msg: { data: string }) => void) | null = null;
    onerror = null;
    onopen = null;
    constructor() {
      NoopEventSource.last = this;
    }
  }

  function stub(routes: Record<string, () => Response>) {
    const fetchMock = vi.fn(async (url: string) => {
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route();
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("EventSource", NoopEventSource);
    return fetchMock;
  }

  it("stops on a failing live server instead of loading the sample", async () => {
    const fetchMock = stub({ "api/scene": () => new Response("boom", { status: 500 }) });
    const store = new Store();
    await store.load();
    expect(store.status).toContain("HTTP 500");
    expect(fetchMock).not.toHaveBeenCalledWith("sample-scene.json");
  });

  it("stops on a live scene with an unsupported version", async () => {
    const fetchMock = stub({ "api/scene": () => Response.json({ version: 9, objects: [] }) });
    const store = new Store();
    await store.load();
    expect(store.status).toContain("unsupported scene version 9");
    expect(fetchMock).not.toHaveBeenCalledWith("sample-scene.json");
  });

  it("falls back to the sample when there is no server", async () => {
    stub({
      "api/scene": () => new Response("not found", { status: 404 }),
      "sample-scene.json": () => Response.json({ version: 2, objects: [] }),
    });
    const store = new Store();
    await store.load();
    expect(store.status).toBe("static: sample-scene.json");
  });

  it("does not apply the connection's first scene event twice", async () => {
    const doc = { version: 2, title: "t", run: "r1", view: "auto", objects: [pt("a")] };
    stub({ "api/scene": () => Response.json(doc) });
    const store = new Store();
    await store.load();
    expect(store.live).toBe(true);
    const events: StoreEvent["type"][] = [];
    store.onChange((ev) => events.push(ev.type));
    NoopEventSource.last!.onmessage!({ data: JSON.stringify({ type: "scene", doc }) });
    expect(events).toEqual(["meta"]);
    expect(store.status).toBe("live");
  });

  it("applies a scene event that differs, or that follows other events", async () => {
    const doc = { version: 2, title: "t", run: "r1", view: "auto", objects: [pt("a")] };
    stub({ "api/scene": () => Response.json(doc) });
    const store = new Store();
    await store.load();
    const source = NoopEventSource.last!;
    source.onmessage!({ data: JSON.stringify({ type: "upsert", objects: [pt("b")] }) });
    expect(ids(store)).toEqual(["a", "b"]);
    source.onmessage!({ data: JSON.stringify({ type: "scene", doc }) }); // e.g. after a reconnect
    expect(ids(store)).toEqual(["a"]);
  });
});

describe("Store.clearAll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a JSON body with a JSON content type and clears the page", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { store } = storeWith("a");
    store.live = true;
    await store.clearAll();
    expect(fetchMock).toHaveBeenCalledWith("api/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(ids(store)).toEqual([]);
  });

  it("reports a refused clear instead of swallowing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 415 })));
    const { store } = storeWith("a");
    store.live = true;
    await store.clearAll();
    expect(store.status).toBe("clear failed: the server answered HTTP 415");
  });

  it("reports an unreachable live server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const { store } = storeWith("a");
    store.live = true;
    await store.clearAll();
    expect(store.status).toBe("clear failed: the server is unreachable");
  });

  it("only clears the page on a static page, where there is no server to ask", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 405 }));
    vi.stubGlobal("fetch", fetchMock);
    const { store } = storeWith("a");
    await store.clearAll();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ids(store)).toEqual([]);
    expect(store.status).toBe("");
  });
});

describe("scene event", () => {
  const doc = (run: string, ...names: string[]) => ({
    version: 2, title: run, run, view: "3d", objects: names.map((n) => pt(n)),
  });

  it("replaces the whole state, then later events apply on top", () => {
    const { store, events } = storeWith("old");
    store.apply({ type: "scene", doc: doc("r2", "a", "b") });
    expect(ids(store)).toEqual(["a", "b"]);
    expect([store.run, store.title, store.view]).toEqual(["r2", "r2", "3d"]);
    expect(store.status).toBe("live");
    store.apply({ type: "upsert", objects: [pt("c")] });
    store.apply({ type: "remove", id: "a" });
    expect(ids(store)).toEqual(["b", "c"]);
    expect(events).toContain("reset");
  });

  it("is a full reset: a pending run swap does not wipe the scene's first upsert", () => {
    const { store } = storeWith("old");
    store.apply({ type: "run", run: "r2", keep: false });
    store.apply({ type: "scene", doc: doc("r2", "a") });
    store.apply({ type: "upsert", objects: [pt("b")] });
    expect(ids(store)).toEqual(["a", "b"]);
  });

  it("shows an unsupported scene instead of throwing", () => {
    const { store } = storeWith("old");
    store.apply({ type: "scene", doc: { version: 9, objects: [] } });
    expect(store.status).toMatch(/unsupported scene version 9/);
  });
});

describe("Store live connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakeEventSource {
    static last: FakeEventSource;
    onmessage: ((msg: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onopen: (() => void) | null = null;
    constructor() {
      FakeEventSource.last = this;
    }
    send(ev: object) {
      this.onmessage?.({ data: JSON.stringify(ev) });
    }
  }

  it("takes its state from the scene event on every (re)connection, without refetching", async () => {
    const fetchMock = vi.fn(async () => Response.json({ version: 2, title: "", run: "r1", view: "auto", objects: [pt("a")] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("EventSource", FakeEventSource);
    const store = new Store();
    await store.load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.status).toBe("live");
    const es = FakeEventSource.last;
    es.send({ type: "scene", doc: { version: 2, title: "", run: "r1", view: "auto", objects: [pt("a"), pt("b")] } });
    es.send({ type: "upsert", objects: [pt("c")] });
    expect(ids(store)).toEqual(["a", "b", "c"]);
    es.onerror?.();
    expect(store.status).toBe("live · reconnecting…");
    es.onopen?.();
    es.send({ type: "scene", doc: { version: 2, title: "", run: "r2", view: "auto", objects: [pt("z")] } });
    expect(ids(store)).toEqual(["z"]);
    expect(store.status).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
