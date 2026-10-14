// Vendored from amplitude/Amplitude-AI-Node @ 792806e27f7a163cd44255863f25f6d2b751a5dc (v0.22.0)
// Source: src/core/privacy.ts
// Adaptations:
//   - Kept the domain-agnostic redaction primitives verbatim: the email
//     pattern, SSN / credit-card / IP patterns, base64-image detection and
//     redaction (isBase64DataUrl, isValidUrl, isRawBase64,
//     redactBase64Content), the content hash (createContentHash),
//     compileCustomRedactionPatterns, and fail-closed custom redaction.
//   - Dropped the agent/LLM-domain surface: $llm_message chunking, contentMode
//     tiers, privacyMode, sanitizeSystemPrompt, sanitizeReasoningContent,
//     sanitizeToolDefinitions, and normalizeToolDefinitions. Those key off
//     upstream event constants and the agent/turn/message taxonomy.
//   - PrivacyConfig keeps redactPii and the custom redaction pattern/function
//     machinery, but its methods are taxonomy-free value transforms
//     (redactText / redactValue) instead of methods that return event-property
//     dictionaries. Base64-image replacement runs inside redactValue and is
//     not gated on redactPii, matching upstream sanitizeStructuredContent.
//   - Phone patterns are still adapted from upstream (v0.22.0 has not picked
//     these up). A parenthesized US number is
//     matched from the opening `(`, so `(555) 123-4567` is fully replaced.
//     International numbers allow spaces, dots, dashes, and parentheses
//     between digits while keeping the 7–15 digit E.164 bound. Upstream only
//     matches an uninterrupted `+` digit run, which left `+44 20 7946 0958`.
//   - IPv6 matching accepts compressed forms (`2001:db8::`, `2001:db8::1:2`)
//     that upstream's regex splits or misses. Scope operators (`std::vector`,
//     `a[::2]`) stay excluded, and a bare `::` is still not an address.
//   - Raw JPEG base64 (`/9j/...`) is recognized before the leading-`/` URL
//     exemption, which otherwise treats the payload as a relative path.
//   - `Date` values pass through `redactValue` unchanged. Walking them as
//     objects yields `{}` because a Date has no enumerable properties.
//   - Logger prefix inherited from the re-labelled src/utils/logger.ts.

import crypto from 'node:crypto';
import { ConfigurationError } from '../exceptions.js';
import { getLogger } from '../utils/logger.js';

/** @internal */
export const REDACTED_IMAGE_PLACEHOLDER = '[base64 image redacted]';
/** Replaces a value when custom redaction fails. @internal */
export const REDACTED_CONTENT_PLACEHOLDER = '[content redacted]';

// Email: every quantifier is bounded and a match may only start where the
// preceding character can't belong to a local part, so matching is linear
// in input length (an unbounded `[...]+@` is quadratic on long runs such as
// "a.a.a..."). Latin/Greek/Cyrillic letters are accepted so local parts like
// "josé" match; Han/Kana/Hangul are excluded so CJK text written without
// spaces before an address isn't swallowed into the match.
const EMAIL_LETTER = '\\p{Script=Latin}\\p{Script=Greek}\\p{Script=Cyrillic}';
const EMAIL_LOCAL = `${EMAIL_LETTER}\\p{M}\\p{N}._%+\\-`;
const EMAIL_LABEL = `${EMAIL_LETTER}\\p{M}\\p{N}\\-`;
const EMAIL_RE = new RegExp(
  `(?<![${EMAIL_LOCAL}])[${EMAIL_LOCAL}]{1,64}@(?:[${EMAIL_LABEL}]{1,63}\\.){1,8}[${EMAIL_LETTER}]{2,63}(?![${EMAIL_LETTER}\\p{M}\\p{N}_])`,
  'gu',
);
// `(?<!\w)` rather than `\b`, so an opening `(` is part of the match.
// `\b` sits between the space and `(`, and the old pattern started at the
// first digit, leaving `Call ([phone]`.
const PHONE_RE = /(?<!\w)\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g;
const CREDIT_CARD_RE = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const SSN_SPACE_RE = /\b\d{3} \d{2} \d{4}\b/g;
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
// URL-bracket form first so `http://[::1]:8080` keeps a single pair of
// brackets. A bare candidate is everything else made of hex and colons.
const IPV6_CANDIDATE_RE = /\/\/\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]{2,}/g;
// 7–15 digits total (`[1-9]` plus 6–14 more), with spaces, dots, dashes, or
// parentheses between digits. An uninterrupted `+14155552671` still matches.
const INTL_PHONE_RE = /(?<!\w)\+[1-9](?:[ \t.\-()]*\d){6,14}\b/g;
// MIME type may be omitted (`data:;base64,`) and may carry parameters
// (`data:image/png;charset=utf-8;base64,`).
const BASE64_DATA_URL_RE = /^data:[^;,]*(?:;[^;,]+)*?;base64,/;
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+=*$/;
// JPEG base64 starts with `/9j/`. `isValidUrl` treats every leading `/` as a
// relative path, which would hide the payload from image redaction.
const IMAGE_BASE64_PREFIXES = ['/9j/', 'iVBORw0KGgo', 'R0lGOD', 'UklGR'];

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
  const imagePayload = IMAGE_BASE64_PREFIXES.some((prefix) => text.startsWith(prefix));
  if (!imagePayload && isValidUrl(text)) return false;
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
  // International before the domestic pattern, so `+1 (415) 555-2671` is one
  // token instead of a leftover `+1` plus a domestic match.
  result = result.replace(INTL_PHONE_RE, '[phone]');
  result = result.replace(PHONE_RE, '[phone]');
  result = result.replace(CREDIT_CARD_RE, '[credit_card]');
  result = result.replace(SSN_RE, '[ssn]');
  result = result.replace(SSN_SPACE_RE, '[ssn]');
  result = result.replace(IPV4_RE, '[ip_address]');
  result = redactIpv6(result);
  return result;
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** A full 8-group address, or one `::` compression standing in for the rest. */
function isIpv6Address(token: string): boolean {
  if (!token.includes(':') || token === '::' || token.includes(':::')) return false;
  const halves = token.split('::');
  if (halves.length > 2) return false;
  const groupsOf = (side: string): string[] | undefined => {
    if (side === '') return [];
    const groups = side.split(':');
    return groups.every((group) => HEX_GROUP.test(group)) ? groups : undefined;
  };
  if (halves.length === 1) {
    const groups = groupsOf(token);
    return groups != null && groups.length === 8;
  }
  const left = groupsOf(halves[0] ?? '');
  const right = groupsOf(halves[1] ?? '');
  // `::` replaces at least one group, so the explicit groups are at most 7.
  return left != null && right != null && left.length + right.length <= 7;
}

/**
 * Colon-leading forms (`::1`) must be free-standing. A letter or `[` before
 * them is a scope operator (`std::vector`, `a[::2]`), not an address.
 * Hex-leading forms must not continue an identifier.
 */
function isFreeStandingIpv6(text: string, offset: number): boolean {
  const before = offset > 0 ? text[offset - 1] : '';
  if (text[offset] === ':') return before === '' || /\s/.test(before ?? '');
  return before === '' || !/\w/.test(before ?? '');
}

function redactIpv6(text: string): string {
  return text.replace(IPV6_CANDIDATE_RE, (match, offset: number) => {
    if (match.startsWith('//[')) {
      return isIpv6Address(match.slice(3, -1)) ? '//[ip_address]' : match;
    }
    if (!isIpv6Address(match) || !isFreeStandingIpv6(text, offset)) return match;
    return '[ip_address]';
  });
}

/** @internal */
export type RedactionPattern = string | { pattern: string; replacement: string };

/**
 * Compile caller-supplied redaction patterns. Throws `ConfigurationError` on
 * an invalid entry so a typo is caught at configuration time instead of
 * silently disabling that rule.
 *
 * @internal
 */
export function compileCustomRedactionPatterns(
  patterns: readonly RedactionPattern[],
): Array<{ regex: RegExp; replacement: string }> {
  if (!Array.isArray(patterns)) {
    throw new ConfigurationError(
      'customRedactionPatterns must be an array of strings or { pattern, replacement } objects',
    );
  }
  return patterns.map((entry, index) => {
    const isObject = entry != null && typeof entry === 'object';
    const source = isObject ? (entry as { pattern: unknown }).pattern : (entry as unknown);
    const replacement = isObject
      ? (entry as { replacement: unknown }).replacement
      : '[REDACTED]';
    if (
      (typeof source !== 'string' && !(source instanceof RegExp)) ||
      typeof replacement !== 'string'
    ) {
      throw new ConfigurationError(
        `customRedactionPatterns[${index}] must be a string or { pattern: string, replacement: string }`,
      );
    }
    try {
      return { regex: new RegExp(source, 'g'), replacement };
    } catch (e) {
      throw new ConfigurationError(
        `customRedactionPatterns[${index}] is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

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
 * Custom redaction fails closed: when `customRedactionFn` throws or returns a
 * non-string, or a custom pattern fails at runtime, the value becomes
 * {@link REDACTED_CONTENT_PLACEHOLDER}. Only the first failure is logged.
 *
 * @internal Not part of the public package surface.
 */
export class PrivacyConfig {
  readonly redactPii: boolean;
  readonly customPatterns: Array<RedactionPattern>;
  private readonly _compiledCustomPatterns: Array<{ regex: RegExp; replacement: string }>;
  private readonly _customRedactionFn: ((text: string) => string) | null;
  private _warnedCustomRedactionFailure = false;

  /** @throws {ConfigurationError} on an invalid custom pattern or a non-function `customRedactionFn`. */
  constructor(options: PrivacyConfigOptions = {}) {
    this.redactPii = options.redactPii ?? true;
    this.customPatterns = options.customRedactionPatterns ?? [];
    this._compiledCustomPatterns = compileCustomRedactionPatterns(this.customPatterns);
    const fn = options.customRedactionFn ?? null;
    if (fn != null && typeof fn !== 'function') {
      throw new ConfigurationError('customRedactionFn must be a function');
    }
    this._customRedactionFn = fn;
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
    // A Date has no enumerable properties, so the object walk below would
    // replace the timestamp with {}.
    if (value instanceof Date) return value;

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
        this._warnCustomRedactionFailure(
          `customRedactionPatterns /${regex.source}/ failed (${e instanceof Error ? e.name : typeof e})`,
        );
        return REDACTED_CONTENT_PLACEHOLDER;
      }
    }
    return result;
  }

  private _applyCustomFn(text: string): string {
    if (this._customRedactionFn == null || typeof text !== 'string') {
      return text;
    }
    let detail: string;
    try {
      const result = this._customRedactionFn(text);
      if (typeof result === 'string') return result;
      detail = `customRedactionFn returned ${typeof result} instead of string`;
    } catch (e) {
      // The exception message may echo the input, so only its type is logged.
      detail = `customRedactionFn threw ${e instanceof Error ? e.name : typeof e}`;
    }
    this._warnCustomRedactionFailure(detail);
    return REDACTED_CONTENT_PLACEHOLDER;
  }

  private _warnCustomRedactionFailure(detail: string): void {
    if (this._warnedCustomRedactionFailure) return;
    this._warnedCustomRedactionFailure = true;
    getLogger().error(
      `${detail}; content replaced with "${REDACTED_CONTENT_PLACEHOLDER}". Further failures from this config are not logged.`,
    );
  }
}
