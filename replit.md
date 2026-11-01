# Discord Moderation Bot

Discord server bot with moderation slash commands, configurable anti-spam timeouts, and persistent moderation records.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/scripts run bot` — run the Discord moderation bot
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required secret: `DISCORD_BOT_TOKEN`; `DATABASE_URL` is provided by the project.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Discord commands and event handlers: `scripts/src/discord-moderation-bot.ts`
- Persistent moderation schema: `lib/db/src/schema/moderation.ts`
- Bot setup guide: `docs/discord-moderation-bot.md`

## Architecture decisions

- The bot runs as a separate background workflow so the shared API server remains independent.
- Anti-spam counts messages without reading their contents, so the privileged Message Content intent is not needed.
- Guild settings and moderation cases are stored in PostgreSQL.

## Product

- `/warn`, `/timeout`, `/kick`, and `/clear` moderation commands.
- `/mod-config` controls per-server spam thresholds and the moderation log channel.
- Automatic timeout after the configured spam threshold is reached.

## User preferences

-

## Gotchas

- The bot needs the `applications.commands` and `bot` invite scopes, plus moderation and channel permissions.
- Global slash commands can take time to appear after first registration.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
