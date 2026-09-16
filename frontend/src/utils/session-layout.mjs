export const LAYOUT_KEY = 'web-ttyd-hub.session-layout.v1';
export function normalizeLayout(value) {
  const names = list => Array.isArray(list) ? [...new Set(list.filter(x => typeof x === 'string'))] : [];
  return { order: names(value?.order), pinned: names(value?.pinned) };
}
export function orderedSessions(sessions, layout) {
  const positions = new Map(layout.order.map((name, index) => [name, index]));
  const pinned = new Set(layout.pinned);
  return [...sessions].sort((a, b) => Number(pinned.has(b.name)) - Number(pinned.has(a.name)) ||
    (positions.get(a.name) ?? Infinity) - (positions.get(b.name) ?? Infinity));
}
export function moveSession(sessions, layout, name, target, after = false) {
  const items = orderedSessions(sessions, layout).map(s => s.name);
  if (name === target || !items.includes(name) || !items.includes(target) ||
      layout.pinned.includes(name) !== layout.pinned.includes(target)) return layout;
  items.splice(items.indexOf(name), 1);
  items.splice(items.indexOf(target) + Number(after), 0, name);
  return { ...layout, order: items };
}
