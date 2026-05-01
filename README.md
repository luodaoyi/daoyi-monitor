# Daoyi-Monitor

Daoyi-Monitor is a lightweight server monitor for Cloudflare Workers, Durable Objects, D1, and a Zig agent.

Current MVP:

- One-click deployment to Cloudflare Workers.
- Static admin UI served by Workers Static Assets.
- Realtime agent reports through Durable Objects WebSocket Hibernation.
- D1 storage for users, agents, settings, notifications, latest status, and 3-minute ring-buffer history.
- Webhook and Telegram notifications through Worker Cron.
- Zig agent with `ws://` and `wss://` WebSocket reporting.
- GitHub Actions CI/release builds for Linux musl plus experimental FreeBSD/macOS targets.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/luodaoyi/daoyi-monitor)

After deployment, run the D1 migration from the Cloudflare deploy flow or Wrangler, then open the Worker URL and create the first admin account.

## Development Plan

See [docs/development-plan.md](docs/development-plan.md).

## Agent

Install from the latest GitHub Release manifest:

```sh
curl -fsSL https://raw.githubusercontent.com/luodaoyi/daoyi-monitor/main/install.sh | sh -s -- \
  --endpoint https://your-worker.workers.dev \
  --token YOUR_AGENT_TOKEN
```

The installer maps `https://...` to `wss://.../ws/agent`, verifies SHA-256 from `manifest.json`, installs `daoyi-agent`, and starts a systemd service when systemd is available.

## License

MIT
