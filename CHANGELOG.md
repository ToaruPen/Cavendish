# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.3] - 2026-04-25

### Fixed

- **jobs**: Hung workers (alive PID but no recent progress) are now reclaimed after 30 minutes; `jobs wait --format=json` with an invalid `--timeout` now emits a JSON-formatted error instead of plain text. ([#234](https://github.com/ToaruPen/Cavendish/pull/234))
- **delete**: Batch deletions no longer report success prematurely. The command now polls the conversation list until the entry has disappeared three times in a row, and throws an explicit error if the entry reappears or never goes away. ([#232](https://github.com/ToaruPen/Cavendish/pull/232))
- **process-lock**: A race where two concurrent processes both believed they had claimed the same stale lock is closed by a serialised replacement gate (`~/.cavendish/cavendish.lock.gate`). The gate is itself self-healing: if the takeover process dies before cleanup, the next acquirer reclaims the gate from the dead holder. ([#231](https://github.com/ToaruPen/Cavendish/pull/231))
- **deep-research**: Follow-up queries now reliably register the send button click instead of silently no-oping when the button is still aria-disabled; hidden stale stop/export controls no longer mask the real ones; completion detection no longer promotes plan text as the final report on the first poll. ([#233](https://github.com/ToaruPen/Cavendish/pull/233))

## [2.1.2] - Earlier

See git history for releases before the introduction of this changelog.

[2.1.3]: https://github.com/ToaruPen/Cavendish/compare/v2.1.2...v2.1.3
