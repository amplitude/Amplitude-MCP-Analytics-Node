/**
 * Entry for the spawned stdio server. The type-stripping hook is registered
 * first (`--import ./stdio-register.mjs`), then this file imports the fixture.
 */
import { pathToFileURL } from 'node:url';

const fixture = process.env.MCP_STDIO_FIXTURE;
if (fixture == null || fixture.length === 0) {
  throw new Error('MCP_STDIO_FIXTURE is required');
}
await import(pathToFileURL(fixture).href);
