// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/utils/resolve-module.ts

/**
 * Wrapper around `createRequire()` for optional dependency loading.
 *
 * This package ships as ESM, so bare `require()` is not available at runtime.
 * Keeping this in a single module lets tests vi.mock() optional resolution.
 *
 * In bundler environments (Turbopack, Webpack, etc.) `createRequire` or
 * `import.meta.url` may be rewritten to nonsensical values, so we wrap
 * the initialisation in a try-catch and degrade gracefully to `null`.
 */
import { createRequire } from 'node:module';

let localRequire: NodeRequire | null = null;
try {
  localRequire = createRequire(import.meta.url);
} catch {
  // Bundler environment — import.meta.url is invalid or createRequire unavailable.
}

export const isBundlerEnvironment = localRequire == null;

export function tryRequire(name: string): Record<string, unknown> | null {
  if (localRequire == null) return null;
  try {
    return localRequire(name) as Record<string, unknown>;
  } catch {
    return null;
  }
}
