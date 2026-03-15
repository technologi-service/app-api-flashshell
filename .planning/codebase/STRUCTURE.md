# Codebase Structure

**Analysis Date:** 2026-03-15

## Directory Layout

```
app-api-flashshell/
├── src/
│   └── index.ts              # Application entry point
├── package.json              # Project metadata and dependencies
├── tsconfig.json             # TypeScript compiler configuration
├── bun.lock                  # Dependency lock file
├── README.md                 # Project documentation
└── .gitignore                # Git exclusions
```

## Directory Purposes

**src:**
- Purpose: Contains all source code for the application
- Contains: TypeScript files implementing API logic
- Key files: `index.ts` (main server entry point)

**Root:**
- Purpose: Project configuration and metadata
- Contains: Package manager configs, TypeScript settings, documentation

## Key File Locations

**Entry Points:**
- `src/index.ts`: Application server initialization, HTTP route definitions, and server startup

**Configuration:**
- `package.json`: Project metadata, script definitions, dependency declarations
- `tsconfig.json`: TypeScript compiler options (target ES2021, ES2022 modules, strict type checking)

**Core Logic:**
- `src/index.ts`: Contains entire application (Elysia instance creation, route registration, server listener)

**Testing:**
- Not present - no test files or test framework configured

## Naming Conventions

**Files:**
- `index.ts` - Standard entry point for source directory

**Directories:**
- `src/` - Source code directory (lowercase, plural)

## Where to Add New Code

**New Feature:**
- Primary code: Add to `src/index.ts` or create new files in `src/` and import into `index.ts`
- Tests: Create `src/[feature].test.ts` or `src/[feature].spec.ts` alongside implementation

**New Component/Module:**
- Implementation: Create new file in `src/` (e.g., `src/services/users.ts`, `src/routes/users.ts`)
- Import: Reference in `src/index.ts` and register with Elysia instance

**Utilities:**
- Shared helpers: Create `src/utils/[utility-name].ts` and export functions for use across modules

## Special Directories

**node_modules:**
- Purpose: External dependencies installed by Bun package manager
- Generated: Yes (by `bun install`)
- Committed: No (excluded via .gitignore)

**.agents:**
- Purpose: Agent configuration and metadata (created by claude/GSD framework)
- Generated: Yes (by GSD initialization)
- Committed: No (excluded via .gitignore)

**.planning:**
- Purpose: Planning documents and codebase analysis artifacts
- Generated: Yes (by `/gsd:map-codebase` and other planning commands)
- Committed: No (excluded via .gitignore)

---

*Structure analysis: 2026-03-15*
