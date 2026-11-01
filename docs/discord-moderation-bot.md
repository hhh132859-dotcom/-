# Discord moderation bot setup

## Connect the bot to a server

1. Create an application and bot in the Discord Developer Portal.
2. Invite it with the `bot` and `applications.commands` OAuth2 scopes.
3. Grant it View Channels, Send Messages, Moderate Members, Kick Members, and Manage Messages permissions. Place its role above members it should moderate.
4. Confirm `DISCORD_BOT_TOKEN` is saved in Replit Secrets.
5. Start the **Discord Moderation Bot** workflow. It registers the slash commands when it connects.

The bot only requests the Guilds and Guild Messages gateway intents. It does not read message text, so the privileged Message Content intent is not required.

## Commands

- `/warn user reason` — save a warning record.
- `/timeout user minutes reason` — timeout a member for 1–40,320 minutes.
- `/kick user reason` — remove a member from the server.
- `/clear amount` — bulk-delete up to 100 recent messages. Discord does not bulk-delete messages older than 14 days.
- `/mod-config spam enabled threshold window_seconds` — configure automatic spam timeouts. Defaults are 5 messages in 8 seconds; the timeout is 5 minutes.
- `/mod-config log-channel channel` — choose the channel for moderation records.
- `/mod-config show` — view current settings.

Settings and moderation cases are stored in the project's PostgreSQL database. The first run needs the development schema to be pushed with `pnpm --filter @workspace/db run push`.
