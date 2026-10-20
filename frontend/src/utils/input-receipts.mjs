const normalized = text => String(text || '').replace(/\r\n?/g, '\n').normalize('NFC').trim();

// Slash commands are handled by the TUI, not submitted as matching user
// messages. Some start a model turn, but that still cannot acknowledge the
// literal command text. Paths and multiline prompts remain ordinary messages.
export function inputKind(text, session) {
  if (session?.shell !== 'codex' && !session?.activity?.detected) return 'terminal';
  return /^\/[\p{L}\p{N}_:-]*(?:[\t ][^\r\n]*)?$/u.test(String(text || '').trim()) ? 'command' : 'prompt';
}

export function receiptCandidates(data) {
  return [...(data.messages || []).filter(m => m.role === 'user'), ...(data.inputReceipts || [])];
}

export function reconcileInputs(pending, data) {
  const candidates = receiptCandidates(data), matched = new Set();
  return pending.filter(item => {
    const receipt = candidates.find(r => !matched.has(r.id) && !item.before.includes(r.id) && normalized(r.text) === normalized(item.text));
    if (receipt) { matched.add(receipt.id); return false; }
    item.before = [...new Set([...item.before, ...candidates.map(r => r.id)])];
    return true;
  });
}
