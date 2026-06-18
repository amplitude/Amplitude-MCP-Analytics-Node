import { PrivacyConfig } from './core/privacy.js';

export interface MCPAnalyticsConfigOptions {
  /** Emit verbose internal logging to the console. Off by default. */
  debug?: boolean;
  /** When true, the SDK builds events normally but does not deliver them. */
  dryRun?: boolean;
  /**
   * Apply the built-in PII patterns (email, phone, SSN, credit card, IPv4/IPv6)
   * to free-form event content — the host enrichment on `ctx.extra` and the
   * properties passed to `trackServerEvent` / `trackToolEvent`. Base64-encoded
   * images in those values are redacted regardless. On by default. Identity and
   * dimension fields (user id, session id, server name, …) are never redacted —
   * doing so would corrupt attribution.
   */
  redactPii?: boolean;
  /**
   * Extra redaction rules applied to free-form content after the built-in PII
   * patterns. A bare string is treated as a regex source replaced with
   * `[REDACTED]`; an object supplies an explicit replacement.
   */
  customRedactionPatterns?: Array<
    string | { pattern: string; replacement: string }
  >;
  /** Final, fully custom redaction pass applied after all pattern-based rules. */
  customRedactionFn?: (text: string) => string;
}

/**
 * Configuration for the Amplitude MCP Analytics SDK.
 *
 * @example
 * ```typescript
 * import { AmplitudeMCPAnalytics, MCPAnalyticsConfig } from '@amplitude/mcp-analytics';
 *
 * const analytics = new AmplitudeMCPAnalytics({
 *   apiKey: process.env.AMPLITUDE_API_KEY!,
 *   serverName: 'my-mcp-server',
 *   serverVersion: '1.0.0',
 *   config: new MCPAnalyticsConfig({
 *     debug: true,
 *     // redactPii is on by default; add custom rules or opt out as needed.
 *     customRedactionPatterns: [{ pattern: '\\bACME-\\d+\\b', replacement: '[ticket]' }],
 *   }),
 * });
 * ```
 */
export class MCPAnalyticsConfig {
  readonly debug: boolean;
  readonly dryRun: boolean;
  readonly redactPii: boolean;
  readonly customRedactionPatterns: Array<
    string | { pattern: string; replacement: string }
  >;
  readonly customRedactionFn: ((text: string) => string) | null;

  constructor(options: MCPAnalyticsConfigOptions = {}) {
    this.debug = options.debug ?? false;
    this.dryRun = options.dryRun ?? false;
    this.redactPii = options.redactPii ?? true;
    this.customRedactionPatterns = options.customRedactionPatterns ?? [];
    this.customRedactionFn = options.customRedactionFn ?? null;
  }

  /**
   * Build the redaction policy applied to free-form event content at emit time.
   * The client constructs this once and threads it through every emit site.
   *
   * @internal Not part of the public package surface.
   */
  toPrivacyConfig(): PrivacyConfig {
    return new PrivacyConfig({
      redactPii: this.redactPii,
      customRedactionPatterns: this.customRedactionPatterns,
      customRedactionFn: this.customRedactionFn ?? undefined,
      debug: this.debug,
    });
  }
}
