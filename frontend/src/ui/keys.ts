export type KeyAction =
  | "fit"
  | "present"
  | "theme"
  | "view2d"
  | "view3d"
  | "uvpane"
  | "framePrev"
  | "frameNext"
  | "escape";

/** Spec §5.1 keys. */
const KEYS: ReadonlyMap<string, KeyAction> = new Map([
  ["f", "fit"],
  ["p", "present"],
  ["t", "theme"],
  ["2", "view2d"],
  ["3", "view3d"],
  ["u", "uvpane"],
  ["arrowleft", "framePrev"],
  ["arrowright", "frameNext"],
  ["escape", "escape"],
]);

/** The digit keys by position, for layouts where they type something else unshifted (AZERTY: é and "). */
const CODES: ReadonlyMap<string, KeyAction> = new Map([
  ["Digit2", "view2d"],
  ["Digit3", "view3d"],
]);

/** Input types that take typed text; checkboxes, buttons and the like do not. */
const NON_TEXT_INPUTS: ReadonlySet<string> = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"]);

interface KeySource {
  key: string;
  /** The physical key (KeyboardEvent.code). */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NON_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

/**
 * The viewer action for a key press, or null. Presses with Ctrl, ⌘ or Alt belong to the
 * browser (Ctrl+F find, ⌘P print), and keys typed into a text field belong to the field.
 */
export function keyAction(ev: KeySource): KeyAction | null {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || isTyping(ev.target)) return null;
  return KEYS.get(ev.key.toLowerCase()) ?? (ev.code ? CODES.get(ev.code) : undefined) ?? null;
}

/** Route key presses on `target` to the handlers; held-down keys do not repeat the action. */
export function mountKeys(handlers: Record<KeyAction, () => void>, target: EventTarget = window): void {
  target.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.repeat) return;
    const action = keyAction(ev);
    if (!action) return;
    ev.preventDefault();
    handlers[action]();
  });
}
