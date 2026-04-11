# AGENTS.md

## WHY

- `cavendish` is a CLI that automates ChatGPT's Web UI with Playwright. It is intended for coding agents that need shell access to ChatGPT Pro-class models, attachments, Projects, and Deep Research.
- The distribution format is an npm package, and the published executable is the `cavendish` binary backed by `dist/index.mjs`.

## WHAT

- `src/commands/`: CLI command implementations for `ask`, `deep-research`, `init`, `doctor`, `status`, `list`, `read`, `delete`, `archive`, `move`, and `projects`.
- `src/core/`: Core logic for Chrome connectivity, ChatGPT DOM operations, output formatting, diagnostics, errors, locking, and shutdown handling.
- `src/core/driver/`: Lower-level UI operation modules such as attachments, Deep Research, and response handling.
- `src/constants/`: Selector definitions for the ChatGPT UI.
- `tests/`: Vitest regression tests covering behaviors such as CDP handling, `doctor`, `init --reset`, unknown flags, and process locking.
- `docs/plan.md`: Project plan and a structured overview of commands and design.
- `docs/live-test.md`: Manual verification steps using a real Chrome / ChatGPT session, including CDP and dedicated profile assumptions.
- `.github/workflows/ci.yml`: CI workflow. Runs `lint`, `typecheck`, `deadcode:ci`, `test`, and `build` on Ubuntu, then runs `test` on macOS and Windows.

## HOW

- Runtime requirements are Node.js 20+, Google Chrome stable, and npm. The main scripts are `npm run build`, `npm run lint`, `npm run typecheck`, `npm run deadcode`, and `npm test`.
- `prepublishOnly` runs `lint`, `typecheck`, `deadcode`, `test`, and `build` in that order.
- The publish workflow runs `deadcode:ci` explicitly before `npm publish --ignore-scripts`, so release automation does not rely on npm lifecycle hooks for dead code enforcement.
- Chrome uses the dedicated profile at `~/.cavendish/chrome-profile` rather than the default profile. CDP metadata is stored in `~/.cavendish/cdp-endpoint.json`.
- `doctor` / `status` are the main entry points for checking CDP, auth, selectors, and integration health. Changes around browser connectivity or authentication should be validated through that path.
- For real-browser-dependent changes, `docs/live-test.md` is the baseline procedure. Session persistence assumes graceful Chrome shutdown rather than force-killing processes.
- The existing tests are organized by behavior, so when behavior changes, the natural place is to update the corresponding `tests/*.test.ts` file or add a regression test at the same level of scope.

## REFERENCES

- `README.md`
- `package.json`
- `.github/workflows/ci.yml`
- `docs/live-test.md`
- `docs/plan.md`
