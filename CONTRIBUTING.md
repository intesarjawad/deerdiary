# Contributing

Follow the [engineering standards](docs/engineering-standards.md). Setup and check commands are in the [README](README.md).

Keep domain logic in `src/core/` pure. Test behavior with deterministic inputs, and keep filesystem, browser, clock and network access in the shell. Use strict types without assertions that hide errors.

`npm ci` installs the pre-commit hook through `prepare`. It checks staged files with Biome, all TypeScript, and Python formatting, lint and types. Run both the web and Python test suites before proposing a change. The `Checks` workflow runs them on every push and pull request: `npm run check`, the build, the bundle size check and the Playwright specs on Chromium, Firefox and WebKit, then Ruff, Pyright and pytest for each Python dependency group.

Generated model metadata is excluded from Biome to preserve byte-exact hashes. Do not format or hand-edit those files as a cleanup.

Use conventional commit subjects in the imperative mood. Describe the problem, resulting behavior and validation in a pull request. Follow the [code of conduct](CODE_OF_CONDUCT.md).
