# Pi Patrick

A small personal-agent demo built with the Pi Coding Agent SDK, a Node.js server, and React.

## Run it

Requires Node.js 22.19 or newer.

```bash
npm install
cp .env.example .env
```

Add an API key to `.env`, then start both the server and the React development app:

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The server runs at <http://127.0.0.1:3001>.

Pi also supports credentials stored by its own login flow. By default this app reads Pi's global configuration from `~/.pi/agent` while keeping its sessions under `.data/sessions`.

## Production-style local run

```bash
npm run build
npm start
```

Open <http://127.0.0.1:3001>.

## Structure

- `src/agent`: Pi SDK setup, application session wrapper, and event translation.
- `src/extensions`: the thin composition layer for tools, commands, and hooks.
- `src/tools`, `src/commands`, `src/hooks`: intentionally empty registration points.
- `src/server`: HTTP API, SSE event stream, and production static-file hosting.
- `resources`: system prompt, prompt templates, and skills.
- `web`: React and Vite client.

The current demo has one active session per server process. It restores the most recent session on startup and supports sending messages, queued follow-ups, cancellation, and starting a new session.
