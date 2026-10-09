import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createContentHash,
  isBase64DataUrl,
  isRawBase64,
  isValidUrl,
  PrivacyConfig,
  REDACTED_IMAGE_PLACEHOLDER,
  redactBase64Content,
  redactPiiPatterns,
} from '../../src/core/privacy.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isBase64DataUrl', () => {
  it('detects base64 data URLs', () => {
    expect(isBase64DataUrl('data:image/png;base64,iVBOR...')).toBe(true);
    expect(isBase64DataUrl('https://example.com')).toBe(false);
  });
});

describe('isValidUrl', () => {
  it('recognizes absolute and relative URLs', () => {
    expect(isValidUrl('https://example.com/path')).toBe(true);
    expect(isValidUrl('./relative/path')).toBe(true);
    expect(isValidUrl('../up')).toBe(true);
    expect(isValidUrl('not a url')).toBe(false);
  });
});

describe('isRawBase64', () => {
  it('detects raw base64 strings', () => {
    expect(isRawBase64(PNG_BASE64)).toBe(true);
    expect(isRawBase64('short')).toBe(false);
    expect(isRawBase64('https://example.com')).toBe(false);
  });

  it('does not flag ULIDs, hex tokens, or UUIDs without dashes', () => {
    expect(isRawBase64('01KRESR2V3E22E29C3JBB8FR8Z')).toBe(false);
    expect(isRawBase64('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
    expect(isRawBase64('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(false);
    expect(isRawBase64('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

describe('createContentHash', () => {
  it('returns a stable SHA-256 hash and an empty string for null', () => {
    expect(createContentHash('hello')).toBe(createContentHash('hello'));
    expect(createContentHash('hello')).toHaveLength(64);
    expect(createContentHash('input-a')).not.toBe(createContentHash('input-b'));
    expect(createContentHash(null)).toBe('');
  });
});

describe('redactBase64Content', () => {
  it('redacts base64 data URLs and raw base64 images', () => {
    expect(redactBase64Content('data:image/png;base64,iVBOR')).toBe(REDACTED_IMAGE_PLACEHOLDER);
    expect(redactBase64Content(PNG_BASE64)).toBe(REDACTED_IMAGE_PLACEHOLDER);
  });

  it('leaves non-strings unchanged', () => {
    expect(redactBase64Content(42)).toBe(42);
    expect(redactBase64Content(null)).toBe(null);
    expect(redactBase64Content(undefined)).toBeUndefined();
  });
});

describe('redactPiiPatterns', () => {
  it('redacts emails, phones, SSNs, credit cards, and IP addresses', () => {
    expect(redactPiiPatterns('Contact user@example.com for info')).toBe('Contact [email] for info');
    expect(redactPiiPatterns('Call (555) 123-4567')).toBe('Call [phone]');
    expect(redactPiiPatterns('Call 555-123-4567')).toBe('Call [phone]');
    expect(redactPiiPatterns('Call +14155552671 today')).toBe('Call [phone] today');
    expect(redactPiiPatterns('Call +44 20 7946 0958 today')).toBe('Call [phone] today');
    expect(redactPiiPatterns('Call +1 (415) 555-2671 today')).toBe('Call [phone] today');
    expect(redactPiiPatterns('Call +44-20-7946-0958 today')).toBe('Call [phone] today');
    expect(redactPiiPatterns('SSN: 123-45-6789')).toBe('SSN: [ssn]');
    expect(redactPiiPatterns('SSN: 123 45 6789')).toBe('SSN: [ssn]');
    expect(redactPiiPatterns('Card: 4111 1111 1111 1111')).toBe('Card: [credit_card]');
    expect(redactPiiPatterns('Server at 192.168.1.1 is down')).toBe('Server at [ip_address] is down');
    expect(redactPiiPatterns('IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
      'IPv6: [ip_address]',
    );
    expect(redactPiiPatterns('loopback ::1')).toBe('loopback [ip_address]');
    expect(redactPiiPatterns('see http://[::1]:8080/health')).toBe('see http://[ip_address]:8080/health');
  });

  it('does not treat scope-resolution operators as IPv6', () => {
    expect(redactPiiPatterns('std::vector and a[::2]')).toBe('std::vector and a[::2]');
  });

  it('redacts repeatedly — global patterns do not skip later calls', () => {
    expect(redactPiiPatterns('a@b.com')).toBe('[email]');
    expect(redactPiiPatterns('c@d.com')).toBe('[email]');
  });

  it('returns non-strings unchanged', () => {
    expect(redactPiiPatterns(42 as unknown as string)).toBe(42);
  });
});

describe('PrivacyConfig', () => {
  it('walks nested objects and arrays, and leaves keys and primitives alone', () => {
    const privacy = new PrivacyConfig();
    expect(
      privacy.redactValue({
        note: 'reach user@x.com',
        count: 3,
        ok: true,
        empty: null,
        nested: { email: 'a@b.com' },
        list: ['c@d.com', 1],
      }),
    ).toEqual({
      note: 'reach [email]',
      count: 3,
      ok: true,
      empty: null,
      nested: { email: '[email]' },
      list: ['[email]', 1],
    });
  });

  it('replaces a value that is entirely a base64 image', () => {
    const privacy = new PrivacyConfig({ redactPii: false });
    expect(privacy.redactValue(PNG_BASE64)).toBe(REDACTED_IMAGE_PLACEHOLDER);
    expect(privacy.redactValue(`data:image/png;base64,${PNG_BASE64}`)).toBe(
      REDACTED_IMAGE_PLACEHOLDER,
    );
  });

  it('skips an invalid custom regex and still applies the valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const privacy = new PrivacyConfig({
      redactPii: false,
      customRedactionPatterns: ['(', 'secret-\\d+'],
    });
    expect(privacy.redactText('token secret-99')).toBe('token [REDACTED]');
    expect(warn).toHaveBeenCalled();
  });

  it('applies a pattern object replacement after built-in patterns', () => {
    const privacy = new PrivacyConfig({
      customRedactionPatterns: [{ pattern: '\\bACME-\\d+\\b', replacement: '[ticket]' }],
    });
    expect(privacy.redactText('user@x.com filed ACME-12')).toBe('[email] filed [ticket]');
  });

  it('keeps the current text when customRedactionFn throws or returns a non-string', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwing = new PrivacyConfig({
      redactPii: false,
      customRedactionFn: () => {
        throw new Error('redactor bug');
      },
    });
    expect(throwing.redactText('keep me')).toBe('keep me');

    const wrongType = new PrivacyConfig({
      redactPii: false,
      customRedactionFn: () => 42 as unknown as string,
    });
    expect(wrongType.redactText('keep me')).toBe('keep me');
    expect(error).toHaveBeenCalled();
  });
});
