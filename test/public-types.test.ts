import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult as SdkCallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { AmplitudeMCPAnalytics } from '../src/client.js';
import type { CallToolResult, McpExtra, McpServerLike } from '../src/core/mcp.js';

/** Fails typecheck unless `T` is assignable to `U`. */
type Assert<T extends U, U> = T;

type _highLevelServer = Assert<McpServer, McpServerLike>;
type _lowLevelServer = Assert<Server, McpServerLike>;
type _v1Extra = Assert<RequestHandlerExtra<ServerRequest, ServerNotification>, McpExtra>;
type _builtResult = Assert<CallToolResult, SdkCallToolResult>;
type _toolErrorResult = Assert<ReturnType<AmplitudeMCPAnalytics['toolError']>, SdkCallToolResult>;

describe('public types stay assignable to the v1 SDK', () => {
  it('keeps the assertions above from being erased', () => {
    const assertions = [
      null as unknown as _highLevelServer,
      null as unknown as _lowLevelServer,
      null as unknown as _v1Extra,
      null as unknown as _builtResult,
      null as unknown as _toolErrorResult,
    ];
    expect(assertions).toHaveLength(5);
  });
});
