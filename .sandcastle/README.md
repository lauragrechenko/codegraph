# Sandbox target: codegraph

A Node/TypeScript repo with no capability pack enabled (`docs/agents/capabilities.md`
is `enabled: []`), so it runs on the runner's **default image** — no per-project
Dockerfile. That image is `node:22-bookworm` plus `git`, `gh`, `jq` and yq, which
is everything the build and the suite need.

## Build the image (in the theseus runner repo)

    # from the theseus checkout
    npm run build-image        # builds sandcastle:theseus

## Run

    theseus run --target /path/to/codegraph --issue <n>

`testCommand`, `checkCommands` and `setupCommand` come from the committed
[`config.json`](./config.json), so no per-run flags are needed — pass them only
to override for one run.

- **setupCommand** — `npm ci && npm run build`. The build is NOT optional: about
  twenty suites (`mcp-*`, `cli-*`, `daemon-*`, `upgrade`) spawn
  `dist/bin/codegraph.js` as a real subprocess, so a worktree carrying source
  only fails the first gate before any agent runs. `npm run build` also runs
  `tsc` and the viewer's vite build, so a type error or a missing wasm/viewer
  asset surfaces here rather than mid-suite.
- **testCommand** — `npm test` (vitest, both workspace projects: `engine` in
  node and `ui` in jsdom). The Rust kernel suites (`__tests__/kernel-*.test.ts`)
  skip themselves when no prebuild is staged; the image ships no Rust toolchain,
  and CI builds those on its own matrix.
- **checkCommands** — `svelte-check` over the viewer tree, read-only. Not run by
  this repo's CI, so treat a red result on unchanged trunk as baseline debt.

There is no CI unit-test workflow here (only `release.yml` and
`deploy-site.yml`), so the commands above mirror `package.json`, not a CI job.
