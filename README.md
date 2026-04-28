# Discord Bot

Single-file Discord ticket / verification / Roblox group management bot.

## Requirements

- Node.js 20 or newer
- (optional) a PostgreSQL database — the bot auto-falls back to local JSON files if `DATABASE_URL` is not set

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Set environment variables:
   - `DISCORD_TOKEN` — required, your bot token from https://discord.com/developers
   - `DATABASE_URL` — optional, e.g. `postgres://user:pass@host:5432/db`
3. Start the bot:
   ```bash
   npm start
   ```

## Notes

- Every command works as both a slash command (`/cmd`) and a prefix command (`.cmd`).
- The help menu (`/help` or `.help`) is paginated 10 commands per page across 17 categories with a category dropdown and `<` / `>` page buttons.
- `/setuptickets channel:#ch type:[verification|tag|both]` configures the ticket panel.
- All user-target commands accept a mention OR a raw user ID.
- User ID `1472482602215538779` is hardcoded as a permanent whitelist / wl-manager / temp-owner and cannot be removed.
- The Postgres schema is created automatically on startup before login.
