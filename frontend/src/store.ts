import { Problem, SceneDoc, SceneObject, ServerEvent, VersionError, ViewMode, parseDoc, parseObject } from "./protocol";

export type StoreEvent =
  | { type: "reset" }
  | { type: "upsert"; objects: SceneObject[] }
  | { type: "remove"; id: string }
  | { type: "meta" };

export type StoreHandler = (ev: StoreEvent) => void;

type LiveScene = { kind: "none" } | { kind: "error"; message: string } | { kind: "doc"; raw: unknown };

const EMPTY: SceneDoc = { version: 2, title: "", run: null, view: "auto", steps: [], objects: [] };
const VIEWS: ReadonlySet<string> = new Set(["auto", "2d", "3d"]);

/** Scene state for the page: loading (static or live), run swaps, problems. */
export class Store {
  objects = new Map<string, SceneObject>();
  problems = new Map<string, Problem>();
  title = "";
  view: ViewMode = "auto";
  run: string | null = null;
  steps: string[] = [];
  status = "";
  private handlers = new Set<StoreHandler>();
  private swapPending = false;
  /** True once the page is connected to a live server (as opposed to a static scene). */
  live = false;
  /** The scene document last loaded from the server, to skip the identical first `scene` event. */
  private lastScene: string | null = null;

  onChange(handler: StoreHandler): void {
    this.handlers.add(handler);
  }

  /** A throwing handler must not starve the others: report it in the status and carry on. */
  private emit(ev: StoreEvent): void {
    let failure: string | null = null;
    for (const handler of this.handlers) {
      try {
        handler(ev);
      } catch (err) {
        console.error("geomcore-viewer: handler failed", err);
        failure = err instanceof Error ? err.message : String(err);
      }
    }
    if (failure === null) return;
    this.status = `render error: ${failure}`;
    if (ev.type !== "meta") this.emit({ type: "meta" }); // refresh the status line; a meta emit never re-emits
  }

  reset(doc: SceneDoc, problems: Problem[] = []): void {
    this.objects.clear();
    this.problems.clear();
    for (const o of doc.objects) this.objects.set(o.id, o);
    for (const p of problems) this.problems.set(p.id, p);
    this.title = doc.title;
    this.view = doc.view;
    this.run = doc.run;
    this.steps = doc.steps ?? [];
    this.swapPending = false;
    this.emit({ type: "reset" });
  }

  /** Apply one live server event (see SCENE.md "Runs"). */
  apply(ev: ServerEvent): void {
    if (ev.type !== "scene") this.lastScene = null; // the state has moved on: a later scene must apply
    switch (ev.type) {
      case "scene": {
        // The first event of every /events connection: the full scene, taken under the
        // server's lock, so everything after it is a delta on top of exactly this. On the
        // first connection it repeats the snapshot connectLive just loaded: skip that one.
        const key = JSON.stringify(ev.doc);
        if (key !== this.lastScene) {
          if (!this.loadJson(ev.doc, "live")) return;
          this.lastScene = key;
        }
        this.setStatus("live");
        return;
      }
      case "run":
        this.run = ev.run;
        this.swapPending = !ev.keep;
        return;
      case "upsert": {
        const objects: SceneObject[] = [];
        const problems: Problem[] = [];
        for (const raw of ev.objects) {
          const parsed = parseObject(raw);
          if ("object" in parsed) objects.push(parsed.object);
          else problems.push(parsed.problem);
        }
        if (typeof ev.title === "string") this.title = ev.title;
        if (typeof ev.view === "string" && VIEWS.has(ev.view)) this.view = ev.view as ViewMode;
        if (Array.isArray(ev.steps)) {
          this.steps = [...new Set(ev.steps.filter((f): f is string => typeof f === "string" && f !== ""))];
        }
        const swap = this.swapPending;
        if (swap) {
          this.swapPending = false;
          this.objects.clear();
          this.problems.clear();
        }
        for (const o of objects) {
          this.objects.set(o.id, o);
          this.problems.delete(o.id);
        }
        // an invalid replacement must not leave the stale object on screen
        let dropped = false;
        for (const p of problems) {
          dropped = this.objects.delete(p.id) || dropped;
          this.problems.set(p.id, p);
        }
        this.emit(swap || dropped ? { type: "reset" } : { type: "upsert", objects });
        return;
      }
      case "remove":
        this.objects.delete(ev.id);
        this.problems.delete(ev.id);
        this.emit({ type: "remove", id: ev.id });
        return;
      case "clear":
        this.objects.clear();
        this.problems.clear();
        this.emit({ type: "reset" });
        return;
    }
  }

  setStatus(text: string): void {
    this.status = text;
    this.emit({ type: "meta" });
  }

  private fail(message: string): void {
    this.reset(EMPTY, [{ id: "_doc", message }]);
    this.setStatus(message);
  }

  /** Replace the scene with a parsed document; version errors are shown, not thrown. */
  loadJson(raw: unknown, origin: string): boolean {
    try {
      const { doc, problems } = parseDoc(raw);
      this.reset(doc, problems);
      return true;
    } catch (err) {
      if (!(err instanceof VersionError)) throw err;
      this.fail(`${origin}: ${err.message}`);
      return false;
    }
  }

  async loadUrl(url: string): Promise<void> {
    this.setStatus(`loading ${url}`);
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      this.fail(`could not load ${url} (${String(err)})`);
      return;
    }
    if (!res.ok) {
      this.fail(`could not load ${url} (HTTP ${res.status})`);
      return;
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      this.fail(`could not load ${url} (not JSON)`);
      return;
    }
    if (this.loadJson(raw, url)) this.setStatus(`static: ${url}`);
  }

  /** `?scene=<url>`, else the live local server, else the bundled sample. */
  async load(): Promise<void> {
    const sceneUrl = new URLSearchParams(location.search).get("scene");
    if (sceneUrl) return this.loadUrl(sceneUrl);
    if ((await this.connectLive()) !== "none") return;
    await this.loadUrl("sample-scene.json");
  }

  private async fetchLiveScene(): Promise<LiveScene> {
    let res: Response;
    try {
      res = await fetch("api/scene");
    } catch {
      return { kind: "none" }; // no server reachable
    }
    if (res.status === 404) return { kind: "none" };
    if (!res.ok) return { kind: "error", message: `live server error (HTTP ${res.status})` };
    try {
      return { kind: "doc", raw: await res.json() };
    } catch {
      return { kind: "none" }; // static host: SPA fallback page, not JSON
    }
  }

  private async connectLive(): Promise<"none" | "live" | "failed"> {
    const scene = await this.fetchLiveScene();
    if (scene.kind === "none") return "none";
    if (scene.kind === "error") {
      this.fail(scene.message);
      return "failed";
    }
    if (!this.loadJson(scene.raw, "live")) return "failed";
    this.live = true;
    this.lastScene = JSON.stringify(scene.raw);
    this.setStatus("live");
    const events = new EventSource("events");
    events.onmessage = (msg) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(msg.data) as ServerEvent;
      } catch {
        console.warn("geomcore-viewer: ignoring malformed event", msg.data);
        return;
      }
      this.apply(ev);
    };
    // EventSource reconnects by itself; the server opens every connection with a `scene` event.
    events.onerror = () => this.setStatus("live · reconnecting…");
    return "live";
  }

  /** The "clear" button: empty the page and, when live, the server's scene. */
  async clearAll(): Promise<void> {
    this.apply({ type: "clear" });
    if (!this.live) return; // a static page: there is no server scene to clear
    try {
      const res = await fetch("api/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) this.setStatus(`clear failed: the server answered HTTP ${res.status}`);
    } catch {
      this.setStatus("clear failed: the server is unreachable");
    }
  }
}
