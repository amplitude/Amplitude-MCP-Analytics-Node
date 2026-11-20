import { McpServer as V1Server } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server as V1LowLevel } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer as V2Server, Server as V2LowLevel } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { detectServerLine } from '../src/core/mcp.js';

describe('detectServerLine', () => {
  it('reads a v1 high-level server from its tool method', () => {
    expect(detectServerLine(new V1Server({ name: 'v1', version: '1.0.0' }))).toBe('v1');
  });

  it('reads a v1 low-level server as v1', () => {
    expect(detectServerLine(new V1LowLevel({ name: 'v1', version: '1.0.0' }, { capabilities: {} }))).toBe('v1');
  });

  it('reads a v2 high-level server from the low-level buildContext', () => {
    expect(detectServerLine(new V2Server({ name: 'v2', version: '1.0.0' }))).toBe('v2');
  });

  it('reads a v2 low-level server as v2', () => {
    expect(
      detectServerLine(new V2LowLevel({ name: 'v2', version: '1.0.0' }, { capabilities: {} })),
    ).toBe('v2');
  });

  it('keeps an unrecognized server on the v1 path', () => {
    expect(detectServerLine({})).toBe('v1');
  });
});
