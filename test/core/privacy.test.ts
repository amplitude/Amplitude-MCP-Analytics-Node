import { describe, expect, it } from 'vitest';
import {
  createContentHash,
  isBase64DataUrl,
  isRawBase64,
  isValidUrl,
  PrivacyConfig,
  REDACTED_IMAGE_PLACEHOLDER,
  redactBase64Content,
  redactPiiPatterns,
  sanitizeStructuredContent,
} from '../../src/core/privacy.js';

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
    // 1x1 transparent PNG, base64-encoded — contains `+/=` like any real image
    expect(
      isRawBase64(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      ),
    ).toBe(true);
    expect(isRawBase64('short')).toBe(false);
    expect(isRawBase64('https://example.com')).toBe(false);
  });

  // Regression: ULIDs use Crockford base32, which is a subset of the base64
  // alphabet, so a naive anchored alnum regex would flag them as images and
  // rewrite tool inputs to "[base64 image redacted]".
  it('does not flag ULIDs as base64', () => {
    expect(isRawBase64('01KRESR2V3E22E29C3JBB8FR8Z')).toBe(false);
    expect(isRawBase64('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
  });

  it('does not flag hex tokens or UUIDs without dashes', () => {
    expect(isRawBase64('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe(false);
    expect(isRawBase64('550e8400e29b41d4a716446655440000')).toBe(false);
  });
});

describe('createContentHash', () => {
  it('returns consistent SHA-256 hash', () => {
    const hash1 = createContentHash('hello');
    const hash2 = createContentHash('hello');
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('differs for different inputs', () => {
    expect(createContentHash('input-a')).not.toBe(createContentHash('input-b'));
  });

  it('returns empty string for null', () => {
    expect(createContentHash(null)).toBe('');
  });
});

describe('redactBase64Content', () => {
  it('redacts base64 data URLs and raw base64 images', () => {
    expect(redactBase64Content('data:image/png;base64,iVBOR')).toBe(
      REDACTED_IMAGE_PLACEHOLDER,
    );
  });

  it('handles non-string input', () => {
    expect(redactBase64Content(42)).toBe(42);
    expect(redactBase64Content(null)).toBe(null);
    expect(redactBase64Content(undefined)).toBe(undefined);
  });
});

describe('redactPiiPatterns', () => {
  it('redacts emails', () => {
    expect(redactPiiPatterns('Contact user@example.com for info')).toBe(
      'Contact [email] for info',
    );
  });

  it('redacts phone numbers', () => {
    expect(redactPiiPatterns('Call (555) 123-4567')).toBe('Call ([phone]');
  });

  it('redacts SSNs', () => {
    expect(redactPiiPatterns('SSN: 123-45-6789')).toBe('SSN: [ssn]');
  });

  it('redacts SSNs with spaces', () => {
    expect(redactPiiPatterns('SSN: 123 45 6789')).toBe('SSN: [ssn]');
  });

  it('redacts credit cards', () => {
    expect(redactPiiPatterns('Card: 4111 1111 1111 1111')).toBe(
      'Card: [credit_card]',
    );
  });

  it('redacts IPv4 addresses', () => {
    expect(redactPiiPatterns('Server at 192.168.1.1 is down')).toBe(
      'Server at [ip_address] is down',
    );
  });

  it('redacts IPv6 full addresses', () => {
    expect(
      redactPiiPatterns('IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334'),
    ).toBe('IPv6: [ip_address]');
  });

  it('redacts IPv6 loopback', () => {
    expect(redactPiiPatterns('localhost is ::1')).toBe(
      'localhost is [ip_address]',
    );
  });

  it('redacts abbreviated IPv6 fully (not partially)', () => {
    expect(redactPiiPatterns('addr fe80::1 here')).toBe(
      'addr [ip_address] here',
    );
    expect(redactPiiPatterns('host 2001:db8::1')).toBe('host [ip_address]');
  });

  it('redacts bracket-enclosed IPv6 in URLs (RFC 2732)', () => {
    expect(redactPiiPatterns('http://[::1]:8080/path')).toBe(
      'http://[ip_address]:8080/path',
    );
  });

  it('does NOT redact scope-resolution operators (::)', () => {
    expect(redactPiiPatterns('std::vector<int>')).toBe('std::vector<int>');
    expect(redactPiiPatterns('a[::2]')).toBe('a[::2]');
    expect(redactPiiPatterns('::Module::Class')).toBe('::Module::Class');
  });

  it('handles mixed IPv6 and scope-resolution in same string', () => {
    expect(
      redactPiiPatterns('Connect to 2001:db8::1 via std::net::TcpStream'),
    ).toBe('Connect to [ip_address] via std::net::TcpStream');
  });

  it('redacts international phone numbers', () => {
    expect(redactPiiPatterns('Call +441234567890')).toBe('Call [phone]');
  });

  it('does NOT match +digits preceded by a word character', () => {
    expect(redactPiiPatterns('result=5+1234567')).toBe('result=5+1234567');
  });

  it('does not treat pipe as a valid TLD character in emails', () => {
    expect(redactPiiPatterns('Invalid: user@example.c|m')).toBe(
      'Invalid: user@example.c|m',
    );
  });

  it('no-ops on non-string input', () => {
    expect(redactPiiPatterns(42 as unknown as string)).toBe(42);
    expect(redactPiiPatterns(null as unknown as string)).toBe(null);
  });

  it('handles multiple PII types in one string', () => {
    const result = redactPiiPatterns(
      'User user@test.com at 192.168.1.1 SSN 123-45-6789',
    );
    expect(result).toContain('[email]');
    expect(result).toContain('[ip_address]');
    expect(result).toContain('[ssn]');
  });
});

describe('sanitizeStructuredContent', () => {
  it('sanitizes nested objects recursively', () => {
    const input = { content: { text: 'Email: user@test.com' } };
    const result = sanitizeStructuredContent(input, true) as Record<
      string,
      unknown
    >;
    const nested = result.content as Record<string, unknown>;
    expect(nested.text).toBe('Email: [email]');
  });

  it('sanitizes arrays', () => {
    const input = ['user@test.com', 'normal text', 42];
    const result = sanitizeStructuredContent(input, true) as unknown[];
    expect(result[0]).toBe('[email]');
    expect(result[1]).toBe('normal text');
    expect(result[2]).toBe(42);
  });

  it('skips PII redaction when disabled but still redacts base64', () => {
    const input = { a: 'user@test.com' };
    const result = sanitizeStructuredContent(input, false) as Record<
      string,
      unknown
    >;
    expect(result.a).toBe('user@test.com');
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeStructuredContent(42, true)).toBe(42);
    expect(sanitizeStructuredContent(null, true)).toBe(null);
    expect(sanitizeStructuredContent(true, true)).toBe(true);
  });
});

describe('PrivacyConfig defaults', () => {
  it('defaults to non-privacy mode with redactPii=true', () => {
    const config = new PrivacyConfig();
    expect(config.privacyMode).toBe(false);
    expect(config.redactPii).toBe(true);
  });
});

describe('PrivacyConfig.redactText', () => {
  it('applies built-in PII redaction by default', () => {
    const pc = new PrivacyConfig();
    expect(pc.redactText('Contact user@test.com')).toBe('Contact [email]');
  });

  it('skips built-in PII redaction when disabled', () => {
    const pc = new PrivacyConfig({ redactPii: false });
    expect(pc.redactText('Contact user@test.com')).toBe('Contact user@test.com');
  });

  it('applies custom string patterns as [REDACTED]', () => {
    const pc = new PrivacyConfig({
      redactPii: false,
      customRedactionPatterns: ['secret-\\d+'],
    });
    expect(pc.redactText('The code is secret-12345')).toBe(
      'The code is [REDACTED]',
    );
  });

  it('applies named replacement objects', () => {
    const pc = new PrivacyConfig({
      redactPii: false,
      customRedactionPatterns: [
        { pattern: '\\bACME-\\d+\\b', replacement: '[ticket_id]' },
      ],
    });
    expect(pc.redactText('See ACME-1234 for details')).toBe(
      'See [ticket_id] for details',
    );
  });

  it('runs the custom function after built-in PII redaction', () => {
    const pc = new PrivacyConfig({
      redactPii: true,
      customRedactionFn: (text) => text.replace('[email]', '[scrubbed_email]'),
    });
    expect(pc.redactText('Contact user@test.com please')).toBe(
      'Contact [scrubbed_email] please',
    );
  });

  it('ignores invalid custom regex patterns gracefully', () => {
    const pc = new PrivacyConfig({
      redactPii: false,
      customRedactionPatterns: ['[invalid'],
    });
    expect(pc.redactText('Hello world')).toBe('Hello world');
  });

  it('handles a throwing custom function gracefully', () => {
    const pc = new PrivacyConfig({
      redactPii: false,
      customRedactionFn: () => {
        throw new Error('boom');
      },
    });
    expect(pc.redactText('safe text')).toBe('safe text');
  });

  it('handles a non-string custom function return gracefully', () => {
    const pc = new PrivacyConfig({
      redactPii: false,
      customRedactionFn: (() => 42) as unknown as (text: string) => string,
    });
    expect(pc.redactText('safe text')).toBe('safe text');
  });
});

describe('PrivacyConfig.redactValue', () => {
  it('recursively redacts string leaves and base64 images', () => {
    const pc = new PrivacyConfig({
      customRedactionPatterns: ['secret-\\d+'],
    });
    const input = {
      note: 'reach me at user@test.com',
      token: 'secret-999',
      avatar: 'data:image/png;base64,iVBOR',
      count: 3,
      tags: ['admin@foo.com', 'plain'],
    };
    const result = pc.redactValue(input) as Record<string, unknown>;
    expect(result.note).toBe('reach me at [email]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.avatar).toBe(REDACTED_IMAGE_PLACEHOLDER);
    expect(result.count).toBe(3);
    expect((result.tags as string[])[0]).toBe('[email]');
    expect((result.tags as string[])[1]).toBe('plain');
  });

  it('returns primitives unchanged', () => {
    const pc = new PrivacyConfig();
    expect(pc.redactValue(42)).toBe(42);
    expect(pc.redactValue(null)).toBe(null);
    expect(pc.redactValue(true)).toBe(true);
  });
});
