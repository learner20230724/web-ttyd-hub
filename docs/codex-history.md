# Project and Codex history picker

The New Session dialog supports **Windows and Linux**. Choose Codex, select a
project, then either create a blank conversation or choose an existing one.
History can be searched by title/UUID, paged, and previewed before opening it.
The preview contains only recent user/assistant text, never analysis, developer
instructions or tool output; text is escaped rather than rendered as HTML.

## Discovery

- The server reads the current account's `CODEX_HOME` (default `~/.codex`). It
  does not fetch history from other machines or change Codex configuration.
- Desktop project metadata is supplemented by project directories in Codex
  history and `HUB_CWD` (or the Hub working directory). Linux CLI-only installs
  do not require desktop metadata.
- When available, Node's built-in SQLite reader opens `state_*.sqlite` read-only.
  Older Node versions, missing databases, or incompatible databases fall back
  to rollout metadata under `sessions/`. `session_index.jsonl` supplies names.
- Archived Codex threads and subagents are excluded. Missing directories are
  filtered. Metadata is cached for up to ten seconds; refresh after this window
  to see newly created sessions. No transcript content is copied into Git.

## Resume behavior

The backend validates the selected UUID, project directory and rollout metadata,
then launches `codex resume <UUID> --yolo` in that project. Like new Codex sessions,
resumed sessions disable the Codex sandbox and approval prompts: only trusted
users should have access to this service.

If that thread already has a Hub terminal, opening it reuses the terminal,
reconnects a stopped terminal, or restores an unexpired Hub archive. Concurrent
requests to resume the same thread in one Hub process share a single launch.
This does not detect an unrelated desktop/CLI process using the same thread;
avoid editing a conversation concurrently in separate applications.

Resume UUIDs and project directories persist across Hub restarts. Existing
ConPTY/tmux processes are reattached, not restarted. Recreating a terminated
terminal resumes its saved selected conversation. A deleted or mismatched
rollout is rejected rather than opening a different project.

## Verification and deployment

`npm test` covers discovery, SQLite/fallback readers, path validation, privacy,
pagination, API reuse, command construction and persistence. Linux integration
tests use real tmux/ttyd with a fake Codex executable, without model requests.
After `npm run build`, run `node tests/codex-picker-browser.cjs` for the dialog's
Windows/Linux API variants and mobile layout. CI runs on both operating systems.

Deploy the backend and rebuild the frontend with the existing `HUB_BASE_PATH`.
Restart only the Hub, not its terminal workers or tmux server. For the existing
Windows deployment, use its local `deploy/manage-windows.ps1 restart-hub` from
an appropriately authorized PowerShell. Linux uses `npm run deploy:web` with the
existing systemd deployment configuration. No APK rebuild is needed for this
online UI change. Deployment is separate from publishing source to GitHub.
