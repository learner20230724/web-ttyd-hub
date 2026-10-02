const esc = '\x1b';
const lines = text => text.replace(/\n/g, '\r\n');
const cursor = (x, y) => `${esc}[${y + 1};${x + 1}H`;
const mode = (number, enabled) => `${esc}[?${number}${enabled ? 'h' : 'l'}`;

// Rehydrate the real terminal buffer, including the saved normal screen when a
// full-screen application is open. Future output is raw PTY bytes, not snapshots.
export function snapshotSequence({ meta: m, screen, normal, history, alternate }) {
  let text = '';
  if (m.alternate_on) {
    text += lines((history ? history + '\n' : '') + normal);
    text += cursor(m.alternate_saved_x, m.alternate_saved_y) + mode(1049, true);
    text += `${esc}[H` + lines(alternate);
  } else text += lines(screen);
  text += `${esc}[0m${esc}[${m.scroll_region_upper + 1};${m.scroll_region_lower + 1}r`;
  text += mode(6, m.origin_flag);
  text += cursor(m.cursor_x, m.cursor_y - (m.origin_flag ? m.scroll_region_upper : 0));
  text += mode(25, m.cursor_flag) + mode(1, m.keypad_cursor_flag) + mode(7, m.wrap_flag);
  text += `${esc}[4${m.insert_flag ? 'h' : 'l'}` + esc + (m.keypad_flag ? '=' : '>');
  for (const [flag, number] of [['mouse_standard_flag', 1000], ['mouse_button_flag', 1002],
    ['mouse_all_flag', 1003], ['mouse_utf8_flag', 1005], ['mouse_sgr_flag', 1006]]) {
    text += mode(number, m[flag]);
  }
  // Clear default tabs and reproduce the pane's stops without moving its cursor.
  text += `${esc}7${esc}[3g`;
  for (const stop of (m.pane_tabs || '').split(',').map(Number).filter(n => n > 0 && n < m.pane_width)) {
    text += `${esc}[${stop + 1}G${esc}H`;
  }
  return text + `${esc}8`;
}

// tmux can report cx == width: the next printable character must wrap. Cursor
// positioning alone clamps to width - 1 and would overwrite the final glyph.
export function pendingWrapSequence(term, meta) {
  if (meta.cursor_x < meta.pane_width || !meta.wrap_flag) return '';
  const buffer = term.buffer.active;
  const line = buffer.getLine(buffer.baseY + meta.cursor_y);
  let column = term.cols - 1;
  let cell = line?.getCell(column);
  if (!cell) return '';
  if (!cell.getWidth() && column > 0) cell = line.getCell(--column);
  const style = [0];
  for (const [flag, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4],
    ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]) {
    if (cell[flag]()) style.push(code);
  }
  for (const [part, code] of [['Fg', 38], ['Bg', 48]]) {
    const color = cell[`get${part}Color`]();
    if (cell[`is${part}RGB`]()) style.push(code, 2, color >> 16 & 255, color >> 8 & 255, color & 255);
    else if (cell[`is${part}Palette`]()) style.push(code, 5, color);
  }
  return `${esc}[${column + 1}G${esc}[${style.join(';')}m${cell.getChars() || ' '}${esc}[0m`;
}

// tmux already answers application queries. Forwarding xterm's second answer
// would inject duplicate device/cursor replies into Codex, shells and editors.
export function suppressQueryReplies(term) {
  for (const prefix of ['', '>', '=']) term.parser.registerCsiHandler({ prefix, final: 'c' }, () => true);
  for (const prefix of ['', '?']) term.parser.registerCsiHandler({ prefix, final: 'n' }, () => true);
  for (const prefix of ['', '?']) term.parser.registerCsiHandler({ prefix, intermediates: '$', final: 'p' }, () => true);
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true);
  term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, () => true);
  for (const number of [10, 11, 12]) term.parser.registerOscHandler(number, data => data === '?');
  term.parser.registerOscHandler(4, data => data.split(';').includes('?'));
}
