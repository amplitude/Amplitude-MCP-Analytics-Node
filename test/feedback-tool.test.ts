import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AmplitudeMCPAnalytics } from '../src/client.js';
import { MCPAnalyticsConfig } from '../src/config.js';
import { createServerContext } from '../src/context/index.js';
import {
  FEEDBACK_RECORDED_TEXT,
  FEEDBACK_TOOL_DEFINITION,
  createFeedbackHandler,
  feedbackToolDefinition,
} from '../src/core/feedback-tool.js';
import type { McpExtra, McpServerLike } from '../src/core/mcp.js';
import type { AmplitudeClientLike, AmplitudeEvent } from '../src/types.js';

function loggerOf(warnings: string[]) {
  return {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

function makeAnalytics(config?: MCPAnalyticsConfig) {
  const tracked: AmplitudeEvent[] = [];
  const warnings: string[] = [];
  const amplitude: AmplitudeClientLike = {
    track: (event) => {
      tracked.push(event);
    },
    flush: () => undefined,
    configuration: { loggerProvider: loggerOf(warnings) },
  };
  const analytics = new AmplitudeMCPAnalytics({
    amplitude,
    serverName: 'test-mcp',
    serverVersion: '9.9.9',
    config,
  });
  return { analytics, tracked, warnings };
}

const feedbackEvents = (tracked: AmplitudeEvent[]) =>
  tracked.filter((event) => event.event_type === '[MCP] Feedback Submitted');

describe('feedback tool definition', () => {
  it('ships the default tool without a comment field', () => {
    expect(FEEDBACK_TOOL_DEFINITION).toMatchObject({
      name: 'submit_feedback',
      title: 'Submit feedback on this server',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
    expect(FEEDBACK_TOOL_DEFINITION.description).toContain("thanks, that's it");
    expect(FEEDBACK_TOOL_DEFINITION.description).toContain("that's wrong");
    expect(FEEDBACK_TOOL_DEFINITION.inputSchema.required).toEqual(['helpful']);
    expect(FEEDBACK_TOOL_DEFINITION.inputSchema.properties.reason?.enum).toContain('wrong_result');
    expect(FEEDBACK_TOOL_DEFINITION.inputSchema.properties).not.toHaveProperty('comment');
  });

  it('adds comment only when capture is on, and rejects an invalid name', () => {
    const withComment = feedbackToolDefinition({ captureComment: true, name: 'rate_help' });
    expect(withComment?.name).toBe('rate_help');
    expect(withComment?.inputSchema.properties.comment?.maxLength).toBe(500);
    expect(withComment?.description).toContain('agreed to share');
    expect(feedbackToolDefinition({ name: 'has a space' })).toBeUndefined();
  });
});

describe('createFeedbackHandler', () => {
  it('emits a tool-scope feedback event and not a tool-call response', () => {
    const tracked: AmplitudeEvent[] = [];
    const handler = createFeedbackHandler(
      {
        amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
        getServerCtx: () =>
          createServerContext({
            server: { name: 'svc', version: '1.0.0' },
            transport: 'streamable-http',
          }),
        getServerIdentity: () => ({ userId: 'user-1' }),
        getClientInfoResolver: () => undefined,
      },
      { server: { _registeredTools: { ping: {}, submit_feedback: {} } } },
    );

    const result = handler(
      {
        helpful: false,
        reason: 'wrong_result',
        solicited: false,
        tools: ['ping', 'not-a-tool', 'ping', 'submit_feedback'],
        comment: 'should be dropped',
      },
      { _meta: { conversation_id: 'conv-1' } } as unknown as McpExtra,
    );

    expect(result.content).toEqual([{ type: 'text', text: FEEDBACK_RECORDED_TEXT }]);
    expect(result.isError).toBeUndefined();
    expect(tracked.map((event) => event.event_type)).toEqual(['[MCP] Feedback Submitted']);
    expect(tracked[0]?.user_id).toBe('user-1');
    expect(tracked[0]?.event_properties).toMatchObject({
      '[MCP] Tool Name': 'submit_feedback',
      '[MCP] Feedback Helpful': false,
      '[MCP] Feedback Reason': 'wrong_result',
      '[MCP] Feedback Solicited': false,
      '[MCP] Feedback Tool Names': ['ping', 'submit_feedback'],
      '[MCP] Feedback Has Comment': false,
      '[MCP] Conversation ID': 'conv-1',
    });
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Feedback Comment');
  });

  it('emits a redacted comment only when capture is on', () => {
    const tracked: AmplitudeEvent[] = [];
    const handler = createFeedbackHandler(
      {
        amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
        getServerCtx: () =>
          createServerContext({
            server: { name: 'svc', version: '1.0.0' },
            transport: 'stdio',
            identity: { userId: 'user-1', resolvedFrom: 'explicit' },
          }),
        getServerIdentity: () => ({ userId: 'user-1' }),
        getClientInfoResolver: () => undefined,
        sanitizeErrorMessage: (message) => message.replace('secret', '<redacted>'),
      },
      { captureComment: true },
    );

    handler({ helpful: true, comment: `hello secret ${'x'.repeat(600)}` }, {} as McpExtra);

    expect(tracked[0]?.event_properties?.['[MCP] Feedback Has Comment']).toBe(true);
    const comment = tracked[0]?.event_properties?.['[MCP] Feedback Comment'];
    expect(comment).toEqual(expect.any(String));
    expect(String(comment)).toContain('<redacted>');
    expect(String(comment)).not.toContain('secret');
    expect(String(comment).length).toBeLessThanOrEqual(500);
  });

  it('keeps Has Comment when the sanitizer drops the text', () => {
    const tracked: AmplitudeEvent[] = [];
    const handler = createFeedbackHandler(
      {
        amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
        getServerCtx: () =>
          createServerContext({
            server: { name: 'svc', version: '1.0.0' },
            transport: 'stdio',
            identity: { userId: 'user-1', resolvedFrom: 'explicit' },
          }),
        getServerIdentity: () => ({ userId: 'user-1' }),
        getClientInfoResolver: () => undefined,
        sanitizeErrorMessage: () => null,
      },
      { captureComment: true },
    );

    handler({ helpful: true, comment: 'jane@example.com' }, {} as McpExtra);

    expect(tracked[0]?.event_properties?.['[MCP] Feedback Has Comment']).toBe(true);
    expect(tracked[0]?.event_properties).not.toHaveProperty('[MCP] Feedback Comment');
  });

  it('drops the anonymous floor unless emitAnonymousEvent is set', () => {
    const tracked: AmplitudeEvent[] = [];
    const anonymous = createFeedbackHandler({
      amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
      getServerCtx: () =>
        createServerContext({
          server: { name: 'svc', version: '1.0.0' },
          transport: 'streamable-http',
        }),
      getServerIdentity: () => undefined,
      getClientInfoResolver: () => undefined,
    });
    anonymous({ helpful: true }, {} as McpExtra);
    expect(tracked).toEqual([]);

    const optedIn = createFeedbackHandler({
      amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
      getServerCtx: () =>
        createServerContext({
          server: { name: 'svc', version: '1.0.0' },
          transport: 'streamable-http',
          emitAnonymousEvent: true,
        }),
      getServerIdentity: () => undefined,
      getClientInfoResolver: () => undefined,
    });
    optedIn({ helpful: true }, {} as McpExtra);
    expect(feedbackEvents(tracked)).toHaveLength(1);
  });

  it('answers without emitting when the server was never instrumented', () => {
    const warnings: string[] = [];
    const tracked: AmplitudeEvent[] = [];
    const handler = createFeedbackHandler({
      amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
      getServerCtx: () => undefined,
      getServerIdentity: () => undefined,
      getClientInfoResolver: () => undefined,
      logger: loggerOf(warnings),
    });

    const result = handler({ helpful: true }, {} as McpExtra);
    expect(result.isError).toBeUndefined();
    expect(tracked).toEqual([]);
    expect(warnings).toHaveLength(1);
    handler({ helpful: false }, {} as McpExtra);
    expect(warnings).toHaveLength(1);
  });

  it('returns an error result and emits nothing when helpful is missing', () => {
    const tracked: AmplitudeEvent[] = [];
    const handler = createFeedbackHandler({
      amplitude: { track: (event) => tracked.push(event), flush: () => undefined },
      getServerCtx: () =>
        createServerContext({
          server: { name: 'svc', version: '1.0.0' },
          transport: 'stdio',
          identity: { userId: 'user-1', resolvedFrom: 'explicit' },
        }),
      getServerIdentity: () => ({ userId: 'user-1' }),
      getClientInfoResolver: () => undefined,
    });

    const result = handler({ reason: 'other' }, {} as McpExtra);
    expect(result.isError).toBe(true);
    expect(tracked).toEqual([]);
  });
});

describe('registerFeedbackTool', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  it('warns and does nothing for a low-level server', () => {
    const { analytics, warnings } = makeAnalytics();
    const server = {} as McpServerLike;
    expect(analytics.registerFeedbackTool(server)).toBe(server);
    expect(warnings.some((warning) => warning.includes('McpServer'))).toBe(true);
  });

  it('skips a name that is already registered or invalid', () => {
    const { analytics, warnings } = makeAnalytics();
    const server = new McpServer({ name: 's', version: '1.0.0' });
    server.registerTool(
      'submit_feedback',
      { description: 'already here' },
      async () => ({ content: [{ type: 'text', text: 'existing' }] }),
    );

    analytics.registerFeedbackTool(server);
    analytics.registerFeedbackTool(server, { name: 'not a name' });

    expect(warnings.some((warning) => warning.includes('already on the server'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('1-64 characters'))).toBe(true);
    const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })
      ._registeredTools;
    expect(registered.submit_feedback?.description).toBe('already here');
    expect(registered['not a name']).toBeUndefined();
  });

  it('lists the tool and emits feedback without a tool-call response', async () => {
    const { analytics, tracked } = makeAnalytics();
    const server = new McpServer({ name: 's', version: '1.0.0' });
    server.registerTool(
      'ping',
      { description: 'ping' },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    );
    analytics.instrumentServer(server, { userId: 'user-7' });
    analytics.registerFeedbackTool(server, { name: 'submit_feedback' });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
    closers.push(async () => {
      await client.close();
      await server.close();
    });

    const listed = await client.listTools();
    const feedback = listed.tools.find((tool) => tool.name === 'submit_feedback');
    expect(feedback?.description).toContain("this didn't work");
    expect(feedback?.inputSchema.required).toContain('helpful');
    expect(feedback?.inputSchema.properties).not.toHaveProperty('comment');
    expect(listed.tools.map((tool) => tool.name)).toContain('ping');

    const result = await client.callTool({
      name: 'submit_feedback',
      arguments: {
        helpful: true,
        solicited: true,
        tools: ['ping', 'made-up'],
      },
    });
    expect(result.isError).toBeUndefined();

    const submitted = feedbackEvents(tracked);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.user_id).toBe('user-7');
    expect(submitted[0]?.event_properties).toMatchObject({
      '[MCP] Feedback Helpful': true,
      '[MCP] Feedback Solicited': true,
      '[MCP] Feedback Tool Names': ['ping'],
      '[MCP] Feedback Has Comment': false,
    });
    expect(tracked.some((event) => event.event_type === '[MCP] Tool Call Response')).toBe(false);

    tracked.length = 0;
    const invalid = await client.callTool({
      name: 'submit_feedback',
      arguments: { helpful: 'yes' },
    });
    expect(invalid.isError).toBe(true);
    expect(tracked.map((event) => event.event_type)).not.toContain('[MCP] Feedback Submitted');
    expect(tracked.map((event) => event.event_type)).not.toContain('[MCP] Tool Call Response');
  });
});
