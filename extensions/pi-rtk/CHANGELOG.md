# Changelog

This changelog follows [Common Changelog](https://common-changelog.org/).

## [0.4.0] - 2026-07-17

### Added

- `/rtk`, `/rtk on`, `/rtk off`, and `/rtk status` session-scoped runtime controls
- Runtime status reporting for binary availability, rewrite counts, unavailable-binary skips, and last failure category
- Footer status showing whether rtk rewriting is on or off
- Bun test coverage for rewrite success, disabled passthrough, missing binaries, timeouts, aborts, parallel calls, `!<cmd>`, and `!!<cmd>`

### Changed

- Route agent `bash` optimization through Pi's asynchronous mutable `tool_call` event instead of registering a replacement bash tool
- Run `rtk rewrite` asynchronously with abort-signal support so Pi's UI and agent event loop do not block
- Treat empty and unchanged rewrite output as fallback results
- Negative-cache unavailable `rtk` binaries until `/rtk on` retries discovery

## [0.3.0] - 2026-03-18

### Changed

- **Breaking:** Require Pi v0.60.0 or later and use Pi's exported `createLocalBashOperations()` helper for optimized `user_bash` handling

## [0.2.0] - 2026-03-15

### Added

- Support for optimizing context-visible user shell commands entered with Pi's `!<cmd>` syntax

## [0.1.0] - 2026-03-09

_Initial release._

[0.4.0]: https://github.com/sherif-fanous/pi-rtk/releases/tag/v0.4.0
[0.3.0]: https://github.com/sherif-fanous/pi-rtk/releases/tag/v0.3.0
[0.2.0]: https://github.com/sherif-fanous/pi-rtk/releases/tag/v0.2.0
[0.1.0]: https://github.com/sherif-fanous/pi-rtk/releases/tag/v0.1.0
