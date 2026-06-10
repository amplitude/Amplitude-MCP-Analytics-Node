// Vendored from amplitude/Amplitude-AI-Node @ 97ea346abd0caf333a3bafbd26b74de1d545f3e7
// Source: src/utils/logger.ts
// Adaptations: default console prefix re-labelled [amplitude-ai] -> [amplitude-mcp-analytics].

export interface Logger {
  debug(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

const defaultLogger: Logger = {
  debug: () => {},
  error: (msg) => console.error(`[amplitude-mcp-analytics] ${msg}`),
  warn: (msg) => console.warn(`[amplitude-mcp-analytics] ${msg}`),
  info: () => {},
};

/**
 * Resolve a logger: prefer a `loggerProvider` exposed on the underlying
 * Amplitude client's configuration, otherwise fall back to console.
 */
export function getLogger(amplitude?: unknown): Logger {
  if (amplitude && typeof amplitude === 'object') {
    const config = (amplitude as Record<string, unknown>).configuration as
      | Record<string, unknown>
      | undefined;
    if (config?.loggerProvider && typeof config.loggerProvider === 'object') {
      return config.loggerProvider as Logger;
    }
  }
  return defaultLogger;
}
