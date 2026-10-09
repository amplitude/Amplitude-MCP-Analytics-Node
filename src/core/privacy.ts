// Vendored from amplitude/Amplitude-AI-Node @ c8ab2be38178b88bf136706ea3ff9a9973fe62bf
// Source: src/core/privacy.ts
// Adaptations:
//   - Kept the domain-agnostic redaction primitives verbatim: the PII regex
//     patterns + redactPiiPatterns, the base64-image detection/redaction
//     (isBase64DataUrl, isValidUrl, isRawBase64, redactBase64Content), and the
//     content hash (createContentHash).
//   - Dropped the agent/LLM-domain surface: $llm_message chunking, contentMode
//     tiers, privacyMode, sanitizeSystemPrompt, sanitizeReasoningContent,
//     sanitizeToolDefinitions, and normalizeToolDefinitions. Those key off
//     upstream event constants and the agent/turn/message taxonomy.
//   - PrivacyConfig keeps redactPii and the custom redaction pattern/function
//     machinery, but its methods are taxonomy-free value transforms
//     (redactText / redactValue) instead of methods that return event-property
//     dictionaries. Base64-image replacement runs inside redactValue and is
//     not gated on redactPii, matching upstream sanitizeStructuredContent.
//   - Logger prefix inherited from the re-labelled src/utils/logger.ts.

import crypto from 'node:crypto';
import { getLogger } from '../utils/logger.js';

/** @internal */
export const REDACTED_IMAGE_PLACEHOLDER = '[base64 image redacted]';

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\b\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// Bare "::" is omitted; free-standing "::" abbreviations require whitespace/
// start-of-string to avoid false positives on scope-resolution operators
// (C++ std::vector, Ruby ::Module, Python a[::2]).  Bracket-enclosed forms
// preceded by "//" are URL-context IPv6 (RFC 2732, e.g. http://[::1]:8080).
const IPV6_RE =
  /(?:(?<=\/\/)\[::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\]|(?<=\/\/)\[::1\]|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|(?<![^\s])::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b|(?<![^\s])::1\b)/g;
const INTL_PHONE_RE = /(?<!\w)\+[1-9]\d{6,14}\b/g;
const BASE64_DATA_URL_RE = /^data:([^;]+);base64,/;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/** @internal */
export function isBase64DataUrl(text: string): boolean {
  return BASE64_DATA_URL_RE.test(text);
}

/** @internal */
export function isValidUrl(text: string): boolean {
  try {
    const result = new URL(text);
    return Boolean(result.protocol && result.hostname);
  } catch {
    // not a valid absolute URL
  }
  return (
    text.startsWith('/') || text.startsWith('./') || text.startsWith('../')
  );
}

/** @internal */
export function isRawBase64(text: string): boolean {
  if (isValidUrl(text)) return false;
  // Standard base64 is always padded to a multiple of 4, and any payload
  // longer than a few bytes of high-entropy data (i.e. anything image-sized)
  // will contain `+`, `/`, or `=`. Requiring one of those characters keeps
  // identifier-style strings that happen to use a subset of the base64
  // alphabet — ULIDs, hex tokens, UUIDs without dashes — from being
  // mis-redacted as base64 images.
  if (text.length <= 20 || text.length % 4 !== 0) return false;
  if (!/[+/=]/.test(text)) return false;
  return RAW_BASE64_RE.test(text);
}

/** @internal */
export function createContentHash(content: unknown): string {
  if (content == null) return '';
  const contentStr = typeof content === 'string' ? content : String(content);
  return crypto.createHash('sha256').update(contentStr, 'utf8').digest('hex');
}

/** @internal */
export function redactBase64Content(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (isBase64DataUrl(value)) return REDACTED_IMAGE_PLACEHOLDER;
  if (isRawBase64(value)) return REDACTED_IMAGE_PLACEHOLDER;
  return value;
}

/** @internal */
export function redactPiiPatterns(text: unknown): string {
  // No-op for non-string inputs. Callers sometimes forward content that
  // hasn't been coerced to a string yet (tool outputs, typed null). This
  // keeps PII redaction safe to enable without caller-side type gating.
  if (typeof text !== 'string') {
    return text as string;
  }
  let result = text;
  result = result.replace(EMAIL_RE, '[email]');
  result = result.replace(PHONE_RE, '[phone]');
  result = result.replace(CREDIT_CARD_RE, '[credit_card]');
  result = result.replace(SSN_RE, '[ssn]');
  result = result.replace(SSN_SPACE_RE, '[ssn]');
  result = result.replace(IPV4_RE, '[ip_address]');
  result = result.replace(IPV6_RE, '[ip_address]');
  result = result.replace(INTL_PHONE_RE, '[phone]');
  return result;
}

/** @internal */
export type RedactionPattern = string | { pattern: string; replacement: string };

/** @internal */
export interface PrivacyConfigOptions {
  redactPii?: boolean;
  customRedactionPatterns?: Array<RedactionPattern>;
  customRedactionFn?: (text: string) => string;
}

/**
 * Holds redaction policy (PII toggle, custom patterns, custom function) and
 * applies it to strings or arbitrary structured values. Unlike the upstream
 * class this carries no agent/LLM event-property shaping — it returns redacted
 * values, and the MCP taxonomy decides how they are emitted.
 *
 * @internal Not part of the public package surface.
 */
export class PrivacyConfig {
  readonly redactPii: boolean;
  readonly customPatterns: Array<RedactionPattern>;
  private readonly _compiledCustomPatterns: Array<{ regex: RegExp; replacement: string }>;
  private readonly _customRedactionFn: ((text: string) => string) | null;

  constructor(options: PrivacyConfigOptions = {}) {
    this.redactPii = options.redactPii ?? true;
    this.customPatterns = options.customRedactionPatterns ?? [];
    this._compiledCustomPatterns = [];
    this._customRedactionFn = options.customRedactionFn ?? null;

    for (const pattern of this.customPatterns) {
      try {
        if (typeof pattern === 'string') {
          this._compiledCustomPatterns.push({
            regex: new RegExp(pattern, 'g'),
            replacement: '[REDACTED]',
          });
        } else if (
          pattern != null &&
          typeof pattern === 'object' &&
          typeof pattern.pattern === 'string' &&
          typeof pattern.replacement === 'string'
        ) {
          this._compiledCustomPatterns.push({
            regex: new RegExp(pattern.pattern, 'g'),
            replacement: pattern.replacement,
          });
        } else {
          getLogger().warn('Skipping custom redaction pattern that is not a string or { pattern, replacement }');
        }
      } catch (e) {
        const raw = typeof pattern === 'string' ? pattern : pattern.pattern;
        getLogger().warn(
          `Invalid custom redaction regex "${raw}": ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /**
   * Redact a single string: built-in PII patterns (when `redactPii` is set),
   * then custom patterns, then the custom function. Non-string input is
   * returned unchanged. Base64-image replacement is applied by {@link redactValue}.
   */
  redactText(text: string): string {
    if (typeof text !== 'string') return text;
    let result = text;
    if (this.redactPii) result = redactPiiPatterns(result);
    result = this._applyCustomPatterns(result);
    return this._applyCustomFn(result);
  }

  /**
   * Recursively redact an arbitrary structured value. Every string leaf is run
   * through {@link redactText} and base64-image redaction; objects and arrays
   * are rebuilt; other primitives pass through unchanged. Object keys are not
   * rewritten.
   */
  redactValue(value: unknown): unknown {
    if (typeof value === 'string') {
      return redactBase64Content(this.redactText(value));
    }

    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      const dict = value as Record<string, unknown>;
      const sanitized: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(dict)) {
        sanitized[key] = this.redactValue(v);
      }
      return sanitized;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item));
    }

    return value;
  }

  private _applyCustomPatterns(text: string): string {
    if (!this._compiledCustomPatterns.length || typeof text !== 'string') {
      return text;
    }
    let result = text;
    for (const { regex, replacement } of this._compiledCustomPatterns) {
      try {
        result = result.replace(regex, replacement);
      } catch (e) {
        getLogger().warn(
          `Custom redaction regex "${regex.source}" failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return result;
  }

  private _applyCustomFn(text: string): string {
    if (this._customRedactionFn == null || typeof text !== 'string') {
      return text;
    }
    try {
      const result = this._customRedactionFn(text);
      if (typeof result === 'string') return result;
      getLogger().error(
        `customRedactionFn returned ${typeof result} instead of string; skipping — PII may not be fully redacted for this event`,
      );
    } catch (e) {
      getLogger().error(
        `customRedactionFn raised an exception: ${e instanceof Error ? e.message : String(e)} — PII may not be fully redacted for this event`,
      );
    }
    return text;
  }
}
