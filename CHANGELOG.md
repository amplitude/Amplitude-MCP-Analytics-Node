# Changelog

Entries through 0.5.2 were backfilled from the GitHub releases. Later entries are generated from Conventional Commits.

## [0.6.0](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.5.2...v0.6.0) (2026-10-08)


### Features

* Read Codex nested turn ids ([#43](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/issues/43)) ([c0a8a25](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/commit/c0a8a251ae0874ca5c930135bd10feadd51fb140))

## [0.5.2](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.4.2...v0.5.2) (2026-10-05)

### Features

* Add tiered tool parameter capture ([#36](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/36))
* Capture client episode correlation metadata ([#39](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/39))
* Add a local MCP playground with an ingestion sink ([#40](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/40))

### Documentation

* Add a porting guide for MCP analytics to other languages ([#38](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/38))

### Miscellaneous

* Publish to npm with trusted publishing ([#42](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/42))

## [0.4.2](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.4.1...v0.4.2) (2026-09-11)

### Bug Fixes

* Derive device ids under a private namespace, not NameSpace_OID ([#31](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/31))
* Fix client name resolution on stateless Streamable HTTP ([#32](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/32))

## [0.4.1](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.4.0...v0.4.1) (2026-08-07)

### Features

* Support SDK 1.21+ tool call rejection reporting ([#29](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/29))
* Add a `rate_limited` error type for HTTP 429 failures ([#28](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/28))

## [0.4.0](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.3.0...v0.4.0) (2026-07-24)

### Features

* Add the [MCP] Tool Call Rejected event for pre-dispatch failures ([#24](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/24))

### Breaking changes

* Remove error type and source as inputs. Callers classify errors with an error code ([#25](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/25))

## [0.3.0](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.2.1...v0.3.0) (2026-07-14)

### Features

* Add `setRationale()`, [MCP] Error HTTP Status, and [MCP] Response HTTP Status ([#20](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/20))
* Scope analytics to one `McpServer`, and add `emitAnonymousEvent` ([#21](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/21))

### Documentation

* Add an event reference ([#22](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/22))

## [0.2.1](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/compare/v0.1.0...v0.2.1) (2026-06-30)

### Miscellaneous

* Publish from a merged release pull request ([#18](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/pull/18))

0.2.0 was published to npm and has no git tag, so it is not a separate heading here.

## [0.1.0](https://github.com/amplitude/Amplitude-MCP-Analytics-Node/releases/tag/v0.1.0) (2026-06-25)

### Features

* Initial release.
