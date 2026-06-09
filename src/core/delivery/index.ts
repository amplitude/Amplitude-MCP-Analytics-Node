// Public re-exports for the delivery layer.
//
// This layer is the seam between the SDK and the underlying Amplitude client:
// a mutable proxy ({@link TrackingProxy}), the track-time hooks that decorate
// it ({@link installTrackCounter}, {@link installTrackHook}), and the
// serverless flush-accounting machinery ({@link registerExitHook}).

export { TrackingProxy } from './proxy.js';
export {
  installTrackCounter,
  installTrackHook,
  getLogger,
  _resetShortIdWarned,
  type Logger,
} from './hooks.js';
export {
  isServerless,
  registerExitHook,
  incrementUnflushedCount,
  settleUnflushedCount,
  getGlobalUnflushedCount,
  _resetServerlessCache,
  _resetUnflushedState,
} from './serverless.js';
