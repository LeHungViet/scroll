# @agentpro/scroll-telegram

Zero-dependency Telegram multi-bot fleet adapter for `@agentpro/scroll`.

## Features

- Long-polling Telegram Bot API client (`createTelegramApi`) with retry backoff, photo download, and file uploads.
- Multi-bot fleet daemon (`createTelegramFleetDaemon`) sharing a persistent Codex App-Server client, AuthStore, Cron Scheduler, WorkerPool, GroupGrantStore, and LongTaskRunner.
- DM-locked inline `/admin` UI (`createTelegramAdminUi`) backed by `@agentpro/scroll/chat`'s transport-agnostic `AdminController`.
- Inline HITL tool approval buttons (`Approve` / `Deny`) bound to single-use per-call tokens.
- Dynamic `plugins: [...]` loader for private extensions and optional voice hooks.

## Usage

```bash
npm install @agentpro/scroll @agentpro/scroll-telegram
scroll-telegram doctor --config ./config.json
scroll-telegram start --config ./config.json
```
