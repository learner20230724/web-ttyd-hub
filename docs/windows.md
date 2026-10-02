# Windows native terminals

Windows uses PowerShell and node-pty/ConPTY instead of tmux/ttyd. Linux keeps
the native terminal stream and independent scrolling implementation.

## Requirements and configuration

- Install Node.js, npm, PowerShell and Codex CLI. Python is needed for optional
  Codex activity detection (`HUB_PYTHON` can select its executable).
- Install root and frontend dependencies with `npm ci` in each directory.
  Building node-pty from source may require the Windows C++ build tools.
- Configure `HUB_AUTH_FILE` before starting. Windows refuses to start without it.
  The private JSON file contains `salt`, `hash`, and `cookieKey` strings. Generate
  random salt and cookie key; `hash` is the hexadecimal SHA-256 of
  `salt + base64(UTF8(username + ':' + password))`. Never commit that file.
- Set `HOST=127.0.0.1` and expose the service only behind an authenticated HTTPS
  reverse proxy. Set `HUB_ALLOWED_ORIGINS` to the exact trusted origin(s),
  comma-separated. The proxy must set `X-Forwarded-Proto` correctly.
- Optional: `HUB_BASE_PATH` for a URL prefix (use the same value during frontend
  build and server startup), `HUB_STATE_FILE`, `HUB_PUBLIC_DIR`, `HUB_CWD`,
  `HUB_POWERSHELL`, and `HUB_CODEX_EXE`.
- Run `npm run build`, then `npm start` with the configured environment.

## Codex and session lifetime

Codex sessions launch with **`--yolo`**, disabling the Codex sandbox and approval
prompts. Expose this capability only to trusted users; programs retain the
Windows account's permissions. This does not grant Windows administrator rights.

Select a project from the local Codex desktop project's metadata. The picker
reads project names and directories, not credentials; missing folders and
unlisted launch directories are rejected.

Workers own their ConPTY processes independently. Closing the browser,
reconnecting, stopping access, or restarting the Hub does not end the shell.
Permanent session removal terminates its worker. Rebooting Windows or logging
out does not preserve running programs. Worker startup changes apply to new
sessions, not to existing Codex processes.

Keep `.env`, `data/`, worker secrets, session history, deployment credentials,
and machine-specific supervisor/tunnel configuration out of Git.

## Verification

`npm test` runs the portable tests plus Windows project and launch-command
regressions. Tests requiring Linux tmux/ttyd are excluded or explicitly skipped
on Windows. Unit tests do not replace authenticated end-to-end checks of a real
ConPTY terminal and its reverse proxy.
