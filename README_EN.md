# Web TTYd Hub — Your terminal, ready to resume

[中文](README.md) · [Clipboard](docs/clipboard.md) · [Deployment](docs/deployment.md) · [AI-readable index](llms.txt)

**Start on your computer. Pick up on your phone. Close the tab while your task keeps running.**

A self-hosted **ttyd + tmux browser terminal session manager**, extending [sosopop/web-ttyd-hub](https://github.com/sosopop/web-ttyd-hub). Create named terminals, switch between installed shells, share sessions across browsers and reconnect to long-running command-line work.

![Web terminal session interface](assets/72643b69-16e1-44ab-841f-cc1dee1b1c0b.png)

## What it solves

| Pain point | Approach |
| --- | --- |
| Too many terminal URLs and processes | Named sessions, sidebar switching and a unified HTTP/WebSocket proxy |
| Closing a tab interrupts access | tmux keeps work available across browser disconnections |
| tmux captures text selection | Optional mouse-off profile and clipboard troubleshooting |
| Too little output history | 10,000 browser scrollback lines; optional 20,000-line tmux history |
| Distracting terminal prompts | Disabled leave confirmation and resize overlay |
| Repeated deployment setup | Loopback ttyd listeners, systemd and authenticated Caddy examples |

The upstream Hub already provides the Vue UI, session lifecycle, shell selection and proxy. This fork adds loopback binding, scrollback/prompt tuning, optional tmux settings and deployment/clipboard documentation. It uses official ttyd without patching its engine.

## Quick start

Requires Node.js 22.12+, npm, ttyd supporting `-W`, and tmux on Linux/macOS. Native Windows is unverified; use WSL.

```bash
sudo apt install ttyd tmux # macOS: brew install ttyd tmux
git clone https://github.com/learner20230724/web-ttyd-hub.git
cd web-ttyd-hub
npm ci --include=dev
npm ci --prefix frontend --include=dev
cp .env.example .env
npm run build
npm start
```

Open `http://localhost:3000`. The example uses loopback; configure authenticated HTTPS for remote access. Development: `npm run dev` (frontend 5173, backend 3000).

Configuration: `HOST` defaults to `0.0.0.0` in code, overridden to `127.0.0.1` in the example. `PORT` defaults to 3000; `TTYD_PORT_RANGE_START` / `TTYD_PORT_RANGE_END` default to 7681 / 7780.

## Chinese names and renaming

Create sessions with Chinese text, spaces and symbols (1–80 Unicode characters after trimming; duplicate names and control characters are rejected). Empty creation names are generated automatically. Click **✎** in the sidebar to rename a running or stopped session; Enter saves and Escape cancels, with IME composition protected.

Labels are separate from stable internal IDs, so renaming preserves the terminal connection and running tasks. Other browsers receive the updated label. `POST /api/sessions` accepts a display name in `name`; responses expose a stable `name` ID and a `displayName` label. Rename via `PATCH /api/sessions/:name` with `{"name":"新的中文名称"}`. Existing ASCII IDs stay compatible. Labels, like the session list, are in memory and do not automatically survive a Hub restart; use the internal ID to reattach surviving tmux sessions.

Run `npm test` (requires ttyd and tmux) and `npm run build`.

## Copy and paste

Select text and use the browser Copy action. Common shortcuts are Ctrl+Shift+C / Ctrl+Shift+V or Cmd+C / Cmd+V; browser/OS behavior varies. Focus the terminal before pasting. Ctrl+C without a selection normally interrupts a command. Optional tmux settings disable mouse capture; application mouse mode may require Shift+drag. Mobile selection and clipboard permissions vary. There is no custom copy button or cross-device clipboard sync. See the [guide](docs/clipboard.md).

## Operational limits

Browser disconnect persistence does not imply reboot recovery. Session metadata is in memory and is not restored automatically after Hub restart; surviving tmux sessions can be attached by creating an entry with the same name. Deleting a session terminates its tmux session. Browser scrollback can reset when the iframe reloads and is separate from tmux history. systemd shutdown may clean up the entire service process group.

No built-in accounts, user isolation or fine-grained permissions: browsers share the service OS user's environment. Use an authenticated HTTPS proxy before public access.

## Discovery and attribution

Keywords: self-hosted web terminal, ttyd session manager, tmux browser terminal, mobile terminal, remote CLI, clipboard troubleshooting, command-line AI coding. [llms.txt](llms.txt) is a factual plain-text index; AI indexing/recommendations are not guaranteed.

MIT as declared in the upstream README. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Thanks to sosopop and the ttyd/tmux maintainers. Independent extension, not an official ttyd release.
