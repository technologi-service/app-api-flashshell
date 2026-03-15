# Technology Stack

**Analysis Date:** 2026-03-15

## Languages

**Primary:**
- TypeScript 5.0+ - Server-side API implementation

**Secondary:**
- JavaScript - Runtime output from TypeScript compilation

## Runtime

**Environment:**
- Bun 1.3.10+ - JavaScript runtime and package manager

**Package Manager:**
- Bun - Fast package manager and runtime (configured in `package.json`)
- Lockfile: `bun.lock` (present)

## Frameworks

**Core:**
- Elysia 1.4.27 - Lightweight TypeScript web framework for HTTP server
  - Location: `src/index.ts`
  - Purpose: REST API server with routing and request handling
  - Dependencies: cookie, exact-mirror, fast-decode-uri-component, memoirist

**Development:**
- TypeScript 5.0+ - Static type checking and compilation
- Bun types - Type definitions for Bun runtime

## Key Dependencies

**Critical:**
- elysia 1.4.27 - Web framework providing HTTP routing and middleware
- @sinclair/typebox 0.34.48 - Runtime type validation library
- cookie 1.1.1 - HTTP cookie parsing and serialization
- file-type 21.3.2 - File type detection (optional, included in elysia ecosystem)

**Type Support:**
- bun-types (latest) - Type definitions for Bun APIs
- @types/node 25.5.0 - Node.js type definitions (transitive)

**Utilities:**
- exact-mirror 0.2.7 - Object mirroring utility
- fast-decode-uri-component 1.0.1 - URI component decoding
- memoirist 0.4.0 - Memoization library

## Configuration

**Environment:**
- No `.env` files present - Configuration through environment variables expected
- Environment file pattern: `.env.local`, `.env.development.local`, `.env.test.local`, `.env.production.local` (in .gitignore)

**Build:**
- TypeScript configuration: `tsconfig.json`
  - Target: ES2021
  - Module: ES2022
  - Strict mode enabled
  - esModuleInterop enabled
  - Module resolution: Node

**Development:**
- Dev command: `bun run --watch src/index.ts`
  - Watches source files for changes and restarts server

## Platform Requirements

**Development:**
- Bun 1.3.10 or newer
- Node.js type compatibility (via @types/node)

**Production:**
- Bun runtime
- Node.js compatible environment (Bun is compatible with Node.js APIs)
- Server port: 3000 (default, configured in `src/index.ts`)

## Script Configuration

**Available Scripts:**
- `bun run dev` - Start development server with file watching
- `bun run test` - Not configured (placeholder)

## Entry Point

**Application Entry:**
- File: `src/index.ts`
- Module export: `src/index.js` (transpiled JavaScript)
- Initializes Elysia server, starts listening on port 3000

---

*Stack analysis: 2026-03-15*
