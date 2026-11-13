# 0008: Web stack and TypeScript version

Status: accepted design; scaffold portion implemented.

Use Preact with signals, Vite and strict TypeScript. The clock will be hand-written SVG; no chart library or additional state library is included. Every npm package is a development dependency so the future local server can remain dependency-free.

TypeScript 7.0.2 accepts the required compiler options. The fallback to 6.0.3 is not needed. The single tsconfig checks source, tests, configuration and TypeScript tools when `tsc --noEmit` runs.

The official Preact TypeScript scaffold supplies `@preact/preset-vite` and `@types/node`; those template dependencies are pinned too. See [version verification](../development.md).
