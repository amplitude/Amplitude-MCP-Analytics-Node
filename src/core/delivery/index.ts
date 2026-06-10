// Internal delivery layer. Nothing here is part of the public package surface;
// it is wired up by the client and exercised by tests. 

// Re-exports are limited to the symbols actually consumed through this barrel
// (by `src/client.ts` and the delivery tests). Functions used only within their
// own module are imported directly from their source file rather than surfaced here.

export { TrackingProxy } from './proxy.js';
export {
  installTrackCounter,
  installTrackHook,
  _resetShortIdWarned,
} from './hooks.js';
export {
  registerExitHook,
  settleUnflushedCount,
  getGlobalUnflushedCount,
  _resetUnflushedState,
} from './serverless.js';
