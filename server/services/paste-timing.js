const { setTimeout: delay } = require('node:timers/promises');

// A write acknowledges the PTY/tmux, not the application's input loop. Codex
// can treat an early Enter as part of a paste burst when the TUI is busy.
// Keep paste and submission separate; never retry Enter (it may confirm a dialog).
async function waitAfterPaste(key) {
  if (key) await delay(key === 'Enter' ? 500 : 80);
}

module.exports = { waitAfterPaste };
