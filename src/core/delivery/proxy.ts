// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/client.ts (the TrackingProxy class).
// Adaptations: extracted into its own module; otherwise verbatim. The
//              unflushed-count bookkeeping stays where AI-Node keeps it — on
//              the host client, not the proxy — so this remains a pure wrapper.

import type { AmplitudeClientLike, AmplitudeEvent } from '../../types.js';

/**
 * Thin mutable wrapper around a potentially-frozen Amplitude client.
 *
 * ES module namespaces (`import * as mod`) are frozen objects whose export
 * bindings cannot be reassigned. Instead of monkey-patching `track` on the
 * real client we keep the replacement on this proxy, which is always a plain
 * mutable object. {@link installTrackCounter} and {@link installTrackHook}
 * reassign `track` here, never on the caller's object.
 *
 * @internal Implementation detail — not part of the public package surface.
 */
export class TrackingProxy implements AmplitudeClientLike {
  private readonly _original: AmplitudeClientLike;
  track: (event: AmplitudeEvent) => void;

  constructor(original: AmplitudeClientLike) {
    this._original = original;
    this.track = original.track.bind(original);
  }

  flush(): unknown {
    return this._original.flush();
  }

  shutdown(): void {
    this._original.shutdown?.();
  }

  get configuration(): Record<string, unknown> | undefined {
    return this._original.configuration;
  }
}
