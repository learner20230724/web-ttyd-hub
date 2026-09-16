// Match ttyd/xterm's default palette. Terminal data is rendered as Vue text,
// never HTML; only numeric SGR parameters can produce CSS values.
const palette = [
  '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
];
const foreground = '#ffffff';
const background = '#000000';
const rgb = (r, g, b) => `rgb(${r}, ${g}, ${b})`;
const byte = n => Number.isInteger(n) && n >= 0 && n <= 255;
function color(value, bold = false) {
  if (typeof value === 'string') return value;
  if (value < 16) return palette[value + (bold && value < 8 ? 8 : 0)];
  if (value < 232) {
    const n = value - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return rgb(levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]);
  }
  const level = 8 + (value - 232) * 10;
  return rgb(level, level, level);
}

export function ansiToRuns(input) {
  const runs = [];
  let state = {};
  let previousStyle = '';
  function append(text) {
    text = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    if (!text) return;
    let fg = state.fg == null ? foreground : color(state.fg, state.bold);
    let bg = state.bg == null ? background : color(state.bg);
    if (state.inverse) [fg, bg] = [bg, fg];
    const style = { color: fg, backgroundColor: bg };
    if (state.bold) style.fontWeight = '700';
    if (state.dim) style.opacity = '0.5';
    if (state.italic) style.fontStyle = 'italic';
    const decorations = [state.underline && 'underline', state.strike && 'line-through'].filter(Boolean);
    if (decorations.length) style.textDecorationLine = decorations.join(' ');
    const key = JSON.stringify(style);
    if (runs.length && key === previousStyle) runs[runs.length - 1].text += text;
    else runs.push({ text, style });
    previousStyle = key;
  }
  function sgr(params) {
    const parts = params.split(';');
    for (let i = 0; i < parts.length; i++) {
      const sub = parts[i].split(':').map(Number);
      const n = sub[0];
      if (n === 0) state = {};
      else if (n === 1) state.bold = true;
      else if (n === 2) state.dim = true;
      else if (n === 3) state.italic = true;
      else if (n === 4) state.underline = sub[1] !== 0;
      else if (n === 7) state.inverse = true;
      else if (n === 9) state.strike = true;
      else if (n === 22) { state.bold = false; state.dim = false; }
      else if (n === 23) state.italic = false;
      else if (n === 24) state.underline = false;
      else if (n === 27) state.inverse = false;
      else if (n === 29) state.strike = false;
      else if (n === 39) delete state.fg;
      else if (n === 49) delete state.bg;
      else if (n >= 30 && n <= 37) state.fg = n - 30;
      else if (n >= 90 && n <= 97) state.fg = n - 90 + 8;
      else if (n >= 40 && n <= 47) state.bg = n - 40;
      else if (n >= 100 && n <= 107) state.bg = n - 100 + 8;
      else if (n === 38 || n === 48) {
        const target = n === 38 ? 'fg' : 'bg';
        const colon = sub.length > 1;
        const mode = colon ? sub[1] : Number(parts[++i]);
        if (mode === 5) {
          const value = colon ? sub[2] : Number(parts[++i]);
          if (byte(value)) state[target] = value;
        } else if (mode === 2) {
          // Colon RGB may include a color-space slot (38:2::r:g:b).
          const values = colon ? sub.slice(sub.length >= 6 ? 3 : 2) : parts.slice(i + 1, i + 4).map(Number);
          if (!colon) i += 3;
          if (values.length === 3 && values.every(byte)) state[target] = rgb(...values);
        }
      }
    }
  }
  const controls = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]/g;
  let offset = 0;
  for (const match of input.matchAll(controls)) {
    append(input.slice(offset, match.index));
    const params = /^\x1b\[([0-9;:]*)m$/.exec(match[0]);
    if (params) sgr(params[1]);
    offset = match.index + match[0].length;
  }
  append(input.slice(offset));
  return runs;
}
