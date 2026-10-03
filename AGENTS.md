# AGENTS.md — damn-my-slow-kt

> AI Agent rules and codebase documentation. Update this file when completing tasks.

## Project Overview
- **Name**: damn-my-slow-kt v0.5.x
- **Purpose**: KT internet SLA speed measurement automation + fee reduction CLI tool
- **What it does**: Automates the entire flow of logging into speed.kt.com, running SLA speed tests (5 rounds, ~25min), and filing fee reduction complaints when speed is below 50% of contract
- **Stack**: TypeScript (ES2020, CommonJS), Node.js 20+, Playwright, SQLite (node:sqlite), Commander CLI
- **Package manager**: npm (use `npm install`, never yarn/pnpm)
- **License**: MIT
- **npm package**: `damn-my-slow-kt` (public)
- **Language of product**: Korean (UI strings, README, commit messages)
- **Language of code**: English (variable names, function names, comments explain "why")

## Development Setup

```bash
npm install                        # Install dependencies
npx playwright install chromium    # Browser binary for automation
npm run build                      # Compile TypeScript → dist/
npm run typecheck                  # tsc --noEmit
npm run lint                       # ESLint
npm test                           # Vitest
```

- No external DB, Redis, or Docker required
- Config file: `~/.damn-my-slow-isp/config-kt.yaml` (YAML, not .env)
- `run` command requires real KT credentials; all other dev tasks work without credentials

## Codebase Structure

```
src/
├── index.ts       # Entry: buildCli() → program.parseAsync()
├── cli.ts         # All CLI commands (init, run, history, report, schedule)
├── config.ts      # YAML config load/save, interfaces, defaults
├── db.ts          # SQLite (Node 22+) / JSON fallback storage
├── kt.ts          # KT speed.kt.com Playwright automation (core logic)
├── migration.ts   # Config version migration system (v1→v2→v3)
├── notify.ts      # Discord webhook + Telegram bot notifications
├── report.ts      # CLI table output (cli-table3)
├── scheduler.ts   # OS scheduler install/remove (launchd/systemd/cron/Windows Task Scheduler)
└── updater.ts     # npm registry version check with 24h cache
tests/
├── config.test.ts     # Unit tests for config defaults
├── db.test.ts         # SpeedDatabase timezone-aware record tests
├── kt-parser.test.ts  # SLA result parser unit tests (parseMbpsValue, summarizeSlaResults)
├── kt-login.test.ts   # KT login URL helpers (isKtAccountsUrl, isPasswordChangeUrl, redactUrl)
├── scheduler.test.ts  # Schedule time calculation (schedule.times, start + interval)
├── scheduler-windows.test.ts  # Windows task classification / action / PowerShell script builders
└── updater.test.ts    # Update-check version comparison (prerelease builds)
```

> Run `tree -I node_modules -I dist` to see the full directory structure.

### Key Files Explained
- **kt.ts** (~1,000 lines): The core business logic. Drives Playwright through KT's SLA test flow. Do NOT modify the browser automation selectors without verifying against the live site
- **cli.ts** (~1,000 lines): All Commander commands. `run` validates required config fields (credentials + phone) via `validateRequiredFields()` before execution. `init --force` pre-fills prompts with existing config values
- **config.ts** (~200 lines): YAML config load/save, interfaces, defaults, `validateRequiredFields()` for required field validation
- **scheduler.ts** (~800 lines): Generates multiple launchd/systemd/cron/Windows Task Scheduler triggers per day from `schedule.times` (explicit list, may cross midnight) or `time` + `retry_interval_minutes` + `max_attempts`. On Windows it registers only `\damn-my-slow-kt` via PowerShell `-EncodedCommand`, detects tasks the user registered manually (any folder/name whose action contains `damn-my-slow-kt`), and never replaces or removes them without explicit confirmation
- **db.ts**: Dual storage backend — tries `node:sqlite` first, falls back to JSON file. Both implement the same interface methods

## Coding Conventions

### TypeScript
- **Module**: CommonJS (`require`/`module.exports` compatible) — Chalk v4, Inquirer v8 are CJS versions
- **Target**: ES2020, `strict: true`
- **Error handling**: Always `catch (e: unknown)`, then `const err = e instanceof Error ? e : new Error(String(e))`
- **No `any`**: Use `unknown` and narrow with type guards
- **String formatting**: Template literals only, never sprintf
- **Async**: All async/await, no callbacks

### Console Output
- Use `chalk` for colors (v4 CJS, not v5 ESM)
- Use emoji as status indicators (✅ ❌ 📊 ⏱ 📡 🐌)
- Check `process.stdout.isTTY` to distinguish interactive vs cron mode

### File Comments
- Korean JSDoc-style block comment at the top of each file explaining purpose
- Inline comments explain "why" (Korean or English), not "what"

### Config System
- YAML-based, not .env
- Deep-merged with defaults on load (tolerant of missing fields)
- Config version tracked in `_config_version` field (current: 3)
- Migrations are interactive — ask user before modifying their config

## Code Quality: Always look back your git status before commit
- Before committing, check `git status` for unnecessary files or code changes
- Run `npm run build` to ensure compilation succeeds
- Run `npm run typecheck` and `npm run lint` to catch issues
- Run `npm test` to verify tests pass
- Review diffs critically — remove debug code, unused imports, commented-out blocks

## Restrictions
- **Never commit credentials** — `config.yaml` is in `.gitignore`
- **Never break CJS compatibility** — don't upgrade to ESM-only packages (Chalk v5, Inquirer v9, etc.)
- **Never modify KT automation selectors** without testing against the live site (speed.kt.com changes break everything)
- **Never use `process.exit()` in library code** — only in CLI entry points
- **Node 20 minimum** — don't use Node 22+ APIs without fallback (see db.ts pattern)

## Mandatory Practices
- Update AGENTS.md when completing any task that changes project structure, conventions, or dependencies
- Run the full check sequence before commit: `npm run typecheck && npm run lint && npm run build && npm test`
- Use conventional commits in Korean: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`
- Keep screenshot-on-error pattern in kt.ts for debugging automation failures
- Test with `--dry-run` flag when possible to avoid filing real complaints

## CI/CD
- **ci.yml**: Runs on every push/PR to main — typecheck → lint → build → test (Node 20 + 22 matrix)
- **publish.yml**: Auto-publishes to npm on version bump (5min debounce, NPM_TOKEN secret)
- Both workflows are validated with `@action-validator/cli`

## Dependencies (pinned major versions)
| Package | Version | Why this version |
|---------|---------|------------------|
| chalk | ^4.x | CJS compatible (v5 is ESM-only) |
| inquirer | ^8.x | CJS compatible (v9+ is ESM-only) |
| playwright | ^1.59.x | KT SLA test requires Chromium; Windows local-network-access grant requires 1.56+ |
| commander | ^12.x | CLI framework |
| axios | ^1.x | HTTP client for notifications + update check |
| js-yaml | ^4.x | Config file parsing |
| cli-table3 | ^0.6.x | Terminal table output |
