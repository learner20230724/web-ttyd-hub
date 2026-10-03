const normalized = text => String(text || '').replace(/\r\n?/g, '\n').normalize('NFC').trim();

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
