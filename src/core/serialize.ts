/** Serialization helpers shared by the event emitters. Internal. */

/**
 * Serialized byte size of a value, or `undefined` when absent or not
 * JSON-serializable. Best-effort — never throws into the emit path.
 * @internal
 */
export function byteSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json == null ? undefined : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}
