# Coding Conventions

**Analysis Date:** 2026-03-15

## Naming Patterns

**Files:**
- Lowercase with no separators (e.g., `index.ts`)
- Entry point follows Next.js/Node convention: `index.ts`

**Functions:**
- camelCase for function names (observed in main export: `listen`)
- Single letter or descriptive names for route handlers (e.g., `() => "Hello Elysia"`)

**Variables:**
- camelCase for variable names (e.g., `app`, `hostname`, `port`)
- Const declaration for module-level instances (e.g., `const app = new Elysia()`)

**Types:**
- PascalCase for class names (e.g., `Elysia`)
- Framework uses TypeScript-first approach with strict mode

## Code Style

**Formatting:**
- No explicit formatter configured (.prettierrc not present)
- Manual formatting observed in codebase
- Indentation: 2 spaces (inferred from existing code)

**Linting:**
- No ESLint configuration present (.eslintrc not found)
- TypeScript strict mode enabled in `tsconfig.json` (`"strict": true`)
- Type checking enforced at compile time

**Key TypeScript Settings:**
- `target: ES2021` - Modern JavaScript target
- `module: ES2022` - Modern module syntax
- `strict: true` - All strict type-checking options enabled
- `esModuleInterop: true` - CommonJS compatibility
- `forceConsistentCasingInFileNames: true` - Case-sensitive imports

## Import Organization

**Order:**
1. Third-party framework imports (`import { Elysia } from "elysia"`)
2. Internal application code (none currently)

**Path Aliases:**
- Not configured (baseUrl and paths commented out in tsconfig.json)
- Direct relative imports from node_modules

## Error Handling

**Patterns:**
- Not explicitly demonstrated in current codebase
- Elysia framework likely handles request-level errors
- No try-catch blocks observed in minimal example

## Logging

**Framework:** console

**Patterns:**
- Use `console.log()` for informational output (see `src/index.ts` line 5-7)
- Template literals for formatted output
- Emoji prefixes used for visual distinction (`🦊`)

## Comments

**When to Comment:**
- Not extensively documented in minimal codebase
- Code is expected to be self-documenting where possible
- Elysia config uses framework conventions

**JSDoc/TSDoc:**
- Not currently in use
- TypeScript types serve as inline documentation

## Function Design

**Size:**
- Minimal functions preferred
- Arrow functions for callbacks and route handlers

**Parameters:**
- Destructured where appropriate (e.g., `app.server?.hostname`, `app.server?.port`)
- Optional chaining used for safe property access

**Return Values:**
- Implicit returns in arrow functions
- Route handlers return response bodies directly

## Module Design

**Exports:**
- Direct execution pattern: server instance created and started inline
- No explicit module exports in entry point
- Application starts on require/import (side effects expected)

**Barrel Files:**
- Not applicable in minimal project structure

---

*Convention analysis: 2026-03-15*
