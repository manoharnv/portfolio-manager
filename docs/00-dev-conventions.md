# 00 · Dev Conventions

Established in Phase 0 alongside the monorepo scaffold and `packages/core`.
**These are binding.** Later work should follow them exactly rather than
re-litigating them; if one turns out to be wrong, change it here first and then
change the code.

Companion to the design spec ([01](01-architecture.md)–[10](10-multi-strategy.md)),
which this document never contradicts — it only fills in the mechanics.

---

## 0.1 Toolchain

| Thing | Choice | Notes |
|---|---|---|
| Runtime | **Node ≥ 22** (`engines.node`) | developed on Node 25 |
| Package manager | **pnpm 11.1.1** (`packageManager` field) | no corepack on the dev machine; `pnpm` is on `PATH` |
| Task runner | **turbo 2.x** | `turbo.json` uses the v2 `tasks` key, not `pipeline` |
| Language | **TypeScript 5.9.3, pinned exactly** | *not* TS 7 — `typescript-eslint@8` declares `typescript >=4.8.4 <6.1.0`, so TS 7 breaks linting. Revisit when typescript-eslint supports it. |
| Tests | **vitest 5** + `@vitest/coverage-v8` | |
| Lint | **eslint 10** flat config + `typescript-eslint@8` | |
| Format | **prettier 3** | 2 spaces, single quotes, semicolons, `printWidth: 100`, trailing commas |

`docs/` and `README.md` are in `.prettierignore` — the spec is hand-formatted
(mermaid, aligned tables) and must never be reflowed by a formatter.

## 0.2 Repo layout

```
packages/<name>/        # libraries    → @pm/<name>
apps/<name>/            # deployables  (backend, strategy, mobile)
functions/              # Firebase Cloud Functions (single package)
infra/                  # Terraform / deploy scripts (not a workspace package)
docs/                   # the spec — only ADD files here; never edit 01–10
```

The workspace globs are `packages/*`, `apps/*`, `functions` (`pnpm-workspace.yaml`).
`apps/` and `functions/` currently hold only a `.gitkeep`.

## 0.3 Anatomy of a package

Every package looks like this. Copy `packages/core` when adding one.

```
packages/<name>/
├── package.json           # name "@pm/<name>", "type": "module", private: true
├── tsconfig.json          # extends ../../tsconfig.base.json; include ["src/**/*.ts"]
├── tsconfig.build.json    # extends ./tsconfig.json; excludes tests + test-utils
├── eslint.config.js       # one line: export { default } from '../../eslint.config.js';
├── vitest.config.ts       # only if the package has tests
└── src/
    ├── index.ts           # the ONLY public entry point — re-exports everything
    ├── <module>.ts
    └── <module>.test.ts   # colocated, same basename
```

`package.json` essentials:

```jsonc
{
  "name": "@pm/<name>",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --coverage",
    "lint": "eslint src"
  }
}
```

Every package MUST define `build`, `typecheck`, `test` and `lint` — the root
scripts are `turbo run <task>` and a package without the script is silently
skipped.

**Adding a package**

1. `mkdir -p packages/<name>/src` and copy the five files above.
2. Declare its own devDependencies (`typescript`, `vitest`, `@vitest/coverage-v8`,
   `eslint`) — pnpm's isolated `node_modules` means a package cannot use a binary
   it does not declare. `typescript-eslint` and `@eslint/js` stay at the root only:
   they are resolved from the root config file.
3. Depend on a sibling with `"@pm/core": "workspace:*"`.
4. `pnpm install`, then `pnpm typecheck && pnpm test && pnpm lint`.

## 0.4 TypeScript rules

`tsconfig.base.json` is strict and **ESM-only**:

- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`.
- **Relative imports carry the `.js` extension**, always — `./schemas.js`, even
  from `schemas.ts`. This is NodeNext, not a mistake.
- `verbatimModuleSyntax` is on → type-only imports must be `import type { X }`
  (or inline `import { fn, type X }`). ESLint auto-fixes this.
- `declaration` + `declarationMap` + `sourceMap` are on; build output is `dist/`.
- `isolatedModules`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are on.

Two consequences worth internalising:

- `noUncheckedIndexedAccess` — `arr[0]` and `record[key]` are `T | undefined`.
  Handle it; do not reach for `!` outside tests.
- `exactOptionalPropertyTypes` — declare optional properties as
  **`field?: T | undefined`**, not `field?: T`. zod infers the former, so the
  narrow form makes a hand-written interface incompatible with its own schema.
  `domain.ts` follows this convention deliberately.

## 0.5 Tests

- **vitest**, files named `<module>.test.ts`, **colocated in `src/`** next to the
  module they test. No separate `test/` tree.
- `pnpm test` runs `vitest run --coverage` per package. `packages/core` enforces
  thresholds: **lines/statements/functions ≥ 90 %, branches ≥ 85 %** — the build
  fails below them.
- Fixture builders live in `src/test-utils.ts`, excluded from the build and from
  coverage. Prefer them over inline literals so a schema change is a one-file fix.
- **No network in unit tests. Ever.** No `fetch`, no sockets, no Firestore, no
  filesystem, no real broker. Adapter packages test against recorded fixtures and
  injected fakes. If a test needs a server, it is not a unit test — it belongs in
  a separately-scripted integration suite that never runs under `pnpm test`.
- **No wall-clock time.** Every function that needs "now" takes it as a parameter
  (`now: Date | string`). Tests pass fixed instants. Nothing in `packages/core`
  calls `Date.now()`.
- Test the **failure** path of anything that guards money, not just the happy path.

## 0.6 `packages/core` is special

- **Runtime dependencies: `zod` and nothing else.** No HTTP client, no Firebase,
  no date library, no lodash. Every other package may depend on core; core depends
  on no other workspace package.
- **Pure.** No I/O, no globals, no mutation of inputs, no clock. Given the same
  arguments it returns the same result. This is what lets the strategy engine and
  the execution backend run the *same* guardrail code and agree.
- Everything public is re-exported from `src/index.ts`; consumers import from
  `@pm/core`, never from `@pm/core/dist/guardrails.js`.

Naming inside core:

| Kind | Convention | Example |
|---|---|---|
| zod schema | `XxxSchema` | `ProposalSchema`, `NormalizedOrderSchema` |
| inferred type | `Xxx` | `type Proposal = z.infer<typeof ProposalSchema>` |
| neutral domain type | hand-written `interface` in `domain.ts` | `NormalizedOrder`, `Quote` |
| constant | `SCREAMING_SNAKE` | `ABS_MAX_ORDER_VALUE_INR` |
| error class | `XxxError`, with typed fields | `BrokerError`, `UnsupportedMappingError` |

docs/03 writes some schemas as bare `Config`/`Proposal`; we use the `…Schema`
suffix uniformly (docs/02 already does for `NormalizedOrderSchema`) so the bare
name is free for the type.

## 0.7 Safety conventions (non-negotiable)

These encode the spec's safety properties in code style:

1. **Fail closed.** Missing evidence is a failure, never a skip. A guardrail with
   no quote, no funds, no instrument or no session **fails**. "Unknown" is never
   "fine" ([02](02-broker-abstraction.md) §2.1, [04](04-execution-backend.md) §4.2).
2. **Throw typed errors; never return `undefined` from a mapping.** An unmapped
   enum (MTF on Kite) throws `UnsupportedMappingError` so it cannot become a
   default on the wire.
3. **Code ceilings beat config.** Caps are `min(config, ABS_*)`; `runGuardrails`
   re-clamps internally even if the caller already called
   `clampConfigToCeilings`. Never add a cap that only lives in config.
4. **Read/write split is structural.** Anything that can place an order lives
   behind `BrokerAdapter`/`createAdapter`. The strategy engine imports
   `BrokerReadAdapter`/`createReadAdapter` only — and `createReadAdapter` returns
   a facade with no order methods on it at runtime either.
5. **No `console`** in library code (ESLint `no-console: error`). Apps log through
   their own structured logger, which redacts credential fields.
6. **Never widen a limit to make a test pass.** Fix the code or the fixture.
7. **No secrets in this repo.** No `.env`, no service-account JSON, no tokens —
   not even examples. `.gitignore` blocks them; do not work around it.

## 0.8 Scripts

From the repo root:

| Command | What it does |
|---|---|
| `pnpm install` | install the workspace |
| `pnpm build` | `turbo run build` — `tsc` per package into `dist/` |
| `pnpm typecheck` | `turbo run typecheck` — `tsc --noEmit`, **including test files** |
| `pnpm test` | `turbo run test` — vitest with coverage |
| `pnpm lint` | `turbo run lint` — eslint |
| `pnpm format` / `format:check` | prettier over code + configs (never `docs/`) |

Scope to one package with `--filter`: `pnpm --filter @pm/core test`.

**Before handing work over, all four of `install`, `typecheck`, `test`, `lint`
must pass from the repo root.** Turbo caches by input hash; `--force` re-runs.

## 0.9 Git

Phase 0 was produced without running any `git` command — the human reviews and
commits. Follow the same rule unless explicitly asked: **do not commit, branch,
or push on the user's behalf.**
