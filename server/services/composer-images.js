// Codex renders local attachments as atomic textarea elements. A Right step
// crosses the entire label; ordinary text that looks like a label moves one
// character. Check that distinction before issuing the one destructive key.
const width = require('string-width');
const { setTimeout: delay } = require('node:timers/promises');

const conflict = () => Object.assign(new Error('终端草稿已变化，无法确认这张图片，请查看全文'), { status: 409 });
function draft(screen) {
  const first = screen.lines.findLastIndex(line => /^›(?: |$)/.test(line));
  if (!screen.active || first < 0 || screen.y < first || screen.y >= screen.lines.length) throw conflict();
  const markers = [];
  for (let y = first; y < screen.lines.length; y++) {
    const line = screen.lines[y];
    for (const match of line.matchAll(/\[Image #(\d+)\]/g)) {
      const x = width(line.slice(0, match.index));
      markers.push({ slot: Number(match[1]), x, y, end: x + match[0].length });
    }
  }
  return markers;
}

function insertedImage(screen) {
  const markers = draft(screen);
  const marker = markers.find(m => m.y === screen.y && (screen.x === m.end || screen.x === m.end + 1));
  return marker && { slot: marker.slot, count: markers.length };
}

async function removeImage(io, target) {
  const start = await io.read();
  const markers = draft(start);
  const matches = markers.filter(m => m.slot === target.slot);
  if (markers.length !== target.count || matches.length !== 1 || new Set(markers.map(m => m.slot)).size !== markers.length) throw conflict();
  const marker = matches[0];
  const sameTarget = screen => {
    const all = draft(screen);
    return all.length === markers.length && all.some(m => m.slot === marker.slot && m.x === marker.x && m.y === marker.y);
  };
  async function waitFor(check) {
    for (let i = 0; i < 25; i++) {
      const screen = await io.read();
      if (check(screen)) return screen;
      await delay(35);
    }
    throw conflict();
  }
  if (start.x !== marker.x || start.y !== marker.y) {
    await io.click(marker.x, marker.y);
    await waitFor(s => sameTarget(s) && s.x === marker.x && s.y === marker.y);
  }
  await io.right();
  await waitFor(s => sameTarget(s) && s.x === marker.end && s.y === marker.y);
  await io.backspace(marker.end, marker.y);
  const after = await waitFor(s => draft(s).length === markers.length - 1);
  // A tap temporarily moves the TUI caret. Restore it when the edited row
  // still has the same layout so subsequent text lands where it was typed.
  const original = start.lines[start.y], current = after.lines[start.y];
  if (start.y === marker.y && current !== undefined) {
    const offset = start.x >= marker.end ? width(original) - width(current) : 0;
    const x = Math.max(2, start.x - offset);
    if (x !== after.x) await io.click(x, start.y).catch(() => {});
  } else if (original === current && start.y !== after.y) {
    await io.click(start.x, start.y).catch(() => {});
  }
}

module.exports = { insertedImage, removeImage, conflict };
