// Stops of the tooltip walkthrough. `targets` are CSS selectors; the highlight covers every visible match, and a
// stop with no visible target is skipped. `sidebar` stops need the sidebar held expanded. Pure data and geometry.
export const walkthroughStops = [
  { id: 'capture', targets: ['[data-tour="capture"]'], title: 'Capture', text: 'Start, pause or resume capture. Paused traffic passes straight through: nothing is recorded and no rule or breakpoint applies.' },
  { id: 'address', targets: ['[data-tour="address"]'], title: 'Proxy address', text: 'Point a device or app at this address; click it to open Proxy settings. The state next to it also toggles capture.' },
  { id: 'devices', sidebar: true, targets: ['[aria-controls="sidebar-devices"]', '#sidebar-devices'], title: 'Devices', text: 'Connect this Mac, a simulator or a phone. A new phone asks for your approval once. Click a device to show only its traffic.' },
  { id: 'browse', sidebar: true, targets: ['[aria-controls="sidebar-applications"]', '#sidebar-applications', '#sidebar-domains'], title: 'Applications and domains', text: 'Narrow the list by app or host. Right-click a host to enable SSL inspection, and pin what you use to Favorites.' },
  { id: 'filters', targets: ['.traffic-filters'], title: 'Filters', text: 'Toggle protocol, content type and status. Press ⌘F to search URLs, bodies or SSE events.' },
  { id: 'table', targets: ['.table-scroll'], title: 'Requests', text: 'Click a row to inspect it. ⌘C copies it as cURL, and right-click has more: replay, pin, breakpoint, Map Local.', emptyText: 'Requests appear here as they happen. Click one to inspect it; right-click for replay, pin, breakpoint and more.' },
  { id: 'inspector', targets: ['.inspector'], title: 'Inspector', text: 'Read-only headers, bodies, timing and live SSE events for the selected request. Dock it to the right or below.' },
  { id: 'rules', targets: ['[data-tour="rules"]'], title: 'Change traffic', text: 'Breakpoints pause and edit a request, response or event. Scripts rewrite with JavaScript. Tools has Map Local, network conditions and the agent (MCP) server.' },
  { id: 'more', targets: ['[data-tour="more"]'], title: 'Everything else', text: 'Settings, this tour and the theme live here. ⌘K opens the command palette, and ⌘/ lists every shortcut.' },
];

// Stops that currently have something to point at, in order.
export function availableStops(stops, hasTarget) {
  return stops.filter(stop => stop.targets.some(hasTarget));
}

// Smallest rectangle covering all given rectangles, kept inside the viewport with a small inset.
export function unionRect(rects, viewport, inset = 4) {
  if (!rects.length) return null;
  const left = Math.max(inset, Math.min(...rects.map(r => r.left)));
  const top = Math.max(inset, Math.min(...rects.map(r => r.top)));
  const right = Math.min(viewport.width - inset, Math.max(...rects.map(r => r.left + r.width)));
  const bottom = Math.min(viewport.height - inset, Math.max(...rects.map(r => r.top + r.height)));
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Where the tooltip goes: the first side (below, above, right, left) with room, else the roomiest one. The result is
// always clamped inside the viewport, so a target that fills the window gets the tooltip laid over its edge.
export function placeTooltip(target, tip, viewport, gap = 12, margin = 10) {
  const room = {
    below: viewport.height - (target.top + target.height) - gap - margin,
    above: target.top - gap - margin,
    right: viewport.width - (target.left + target.width) - gap - margin,
    left: target.left - gap - margin,
  };
  const fits = side => side === 'below' || side === 'above' ? room[side] >= tip.height : room[side] >= tip.width;
  const order = ['below', 'above', 'right', 'left'];
  const side = order.find(fits) ?? order.reduce((best, next) => {
    const score = name => name === 'below' || name === 'above' ? room[name] / tip.height : room[name] / tip.width;
    return score(next) > score(best) ? next : best;
  });
  const centerX = target.left + target.width / 2 - tip.width / 2, centerY = target.top + target.height / 2 - tip.height / 2;
  const raw = side === 'below' ? { left: centerX, top: target.top + target.height + gap }
    : side === 'above' ? { left: centerX, top: target.top - gap - tip.height }
    : side === 'right' ? { left: target.left + target.width + gap, top: centerY }
    : { left: target.left - gap - tip.width, top: centerY };
  const clamp = (value, max) => Math.round(Math.max(margin, Math.min(value, max - margin)));
  return { side, left: clamp(raw.left, viewport.width - tip.width), top: clamp(raw.top, viewport.height - tip.height) };
}
