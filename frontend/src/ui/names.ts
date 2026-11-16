import type { SceneObject } from "../protocol";

/** The id without `prefix·`, or the id when it does not start with that prefix. */
function withoutPrefix(id: string, prefix: string): string {
  return prefix && id.startsWith(`${prefix}·`) ? id.slice(prefix.length + 1) : id;
}

/**
 * What a panel row or a view label shows: the object's own label, else its id without the step
 * and the result group. Both are already visible around it (the step in the header, the group in
 * the panel), so a result part reads `curve1`, not `step·intersection·curve1`. The id stays the
 * key and the hover tooltip says it in full.
 */
export function displayName(o: SceneObject): string {
  if (o.label) return o.label;
  return withoutPrefix(withoutPrefix(o.id, o.step ?? ""), o.group ?? "");
}
