# Changelog

## [Unreleased]

### Added

- Added an `authorizationServerMetadataUrl` option to `authorizeMcp()` to use a configured authorization server metadata document instead of discovery ([#10172](https://github.com/earendil-works/pi/issues/10172)).
- Added an `iss` option to `authorizeMcp()`. The authorization code is only exchanged when `iss` names the flow's authorization server, or is absent and the server's metadata does not set `authorization_response_iss_parameter_supported` (RFC 9207).

### Fixed

- Fixed OAuth token and client registration responses with an empty or `null` optional field (such as `"scope": ""`) failing with `Invalid scope` and similar errors; such fields are now treated as absent ([#10266](https://github.com/earendil-works/pi/issues/10266)).
- Fixed `expires_in: null` in a token response marking the access token as already expired.
- Fixed invalid URLs in protected resource metadata aborting OAuth discovery instead of falling back to the MCP server's origin.
- Fixed an empty requested scope, from `scope=""` in a `WWW-Authenticate` challenge or an empty `scopes_supported`, overriding the next scope source.
- Fixed list pagination failing with a duplicate cursor error when a server ends pagination with `nextCursor: ""` or `null`.

## [0.99.2] - 2026-09-30

### Fixed

- Fixed `StreamableHttpTransport` failing every request on Cloudflare Workers with `Illegal invocation` by calling `fetch`, including `UnauthorizedContext.fetch`, without a receiver ([#10188](https://github.com/earendil-works/pi/issues/10188))

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Added a standalone MCP client with JSON-RPC lifecycle, tool discovery and calls, cancellation, progress, roots, stdio and Streamable HTTP transports, and an in-memory testing transport.
