// Recognize complete terminal tables only; leave incomplete output and normal code intact.
const plain = value => value.replace(/\x1b\[[0-9;:]*m/g, '');
const border = line => /^\s*[+┌┬┐├┼┤└┴┘╭╮╰╯┏┳┓┣╋┫┗┻┛╔╦╗╠╬╣╚╩╝─━═-]+\s*$/.test(line) && /[─━═-]{2}/.test(line);
const cells = line => {
  const t = line.trim();
  if (!/^[|│┃║]/.test(t) || !/[|│┃║]$/.test(t)) return null;
  return t.slice(1, -1).split(/[|│┃║]/).map(x => x.trim());
};
export function terminalSegments(text = '') {
  const lines = text.split('\n'), result = [];
  let pending = [];
  const flush = () => { if (pending.length) { result.push({ type:'text', text:pending.join('\n') }); pending = []; } };
  for (let i = 0; i < lines.length; i++) {
    if (border(plain(lines[i]))) {
      let j = i + 1, rows = [], lastBorder = false;
      for (; j < lines.length; j++) {
        const clean = plain(lines[j]);
        if (border(clean)) { lastBorder = true; continue; }
        const row = cells(clean);
        if (!row || row.length < 2 || (rows.length && row.length !== rows[0].length)) break;
        rows.push(row); lastBorder = false;
      }
      if (rows.length >= 2 && lastBorder) { flush(); result.push({type:'table',rows}); i = j - 1; continue; }
    }
    pending.push(lines[i]);
  }
  flush();
  return result;
}
const escape = value => value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
export function tableMarkdown(text) {
  // A fenced box table is presentation output, not source code. Don't change other fences.
  text = text.replace(/```[^\n]*\n([\s\S]*?)\n```/g, (original, body) => {
    const segments = terminalSegments(body);
    return segments.some(s => s.type === 'table') && segments.every(s => s.type === 'table' || !s.text.trim()) ? body : original;
  });
  return terminalSegments(text).map(s => s.type === 'text' ? s.text :
    '<table><tbody>' + s.rows.map(row => '<tr>' + row.map(cell => '<td>' + escape(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>').join('\n\n');
}
