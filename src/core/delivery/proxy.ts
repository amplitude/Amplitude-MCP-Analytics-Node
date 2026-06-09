// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/client.ts (the TrackingProxy class).
// Adaptations: added a public `trackCountSinceFlush` field and wired
//              flush()/shutdown() to settle it against the module-level
//              unflushed counter — in AI-Node that bookkeeping lived on the
//              AmplitudeAI class; here it belongs to the proxy so the host
//              client stays a thin pass-through.

import type { AmplitudeClientLike, AmplitudeEvent } from '../../types.js';
import { settleUnflushedCount } from './serverless.js';

/**
 * Thin mutable wrapper around a potentially-frozen Amplitude client.
 *
 * ES module namespaces (`import * as mod`) are frozen objects whose export
 * bindings cannot be reassigned. Instead of monkey-patching `track` on the
 * real client we keep the replacement on this proxy, which is always a plain
 * mutable object. {@link installTrackCounter} and {@link installTrackHook}
 * reassign `track` here, never on the caller's object.
 */
export class TrackingProxy implements AmplitudeClientLike {
  private readonly _original: AmplitudeClientLike;
  track: (event: AmplitudeEvent) => void;
  /** Events tracked since the last flush()/shutdown() — drives the exit warning. */
  trackCountSinceFlush = 0;

  constructor(original: AmplitudeClientLike) {
    this._original = original;
    this.track = original.track.bind(original);
  }

  flush(): unknown {
    settleUnflushedCount(this.trackCountSinceFlush);
    this.trackCountSinceFlush = 0;
    return this._original.flush();
  }

  shutdown(): void {
    settleUnflushedCount(this.trackCountSinceFlush);
    this.trackCountSinceFlush = 0;
    this._original.shutdown?.();
  }

  get configuration(): Record<string, unknown> | undefined {
    return this._original.configuration;
  }
}
