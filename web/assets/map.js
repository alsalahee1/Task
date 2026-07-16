// Schematic SVG airport map (1000x600 map units, ~1 unit = 1 m).
// GPS lat/lng ↔ map x/y linear transform must match server/db.js MAP_REF.
const REF = { lat0: 25.256, lng0: 55.36, scale: 1e5 };
export const llToXy = (lat, lng) => ({
  x: (lng - REF.lng0) * REF.scale,
  y: (REF.lat0 - lat) * REF.scale,
});

const TYPE_COLORS = {
  GATE: '#60a5fa', STORAGE: '#a78bfa', CHECKIN: '#34d399',
  BAGGAGE: '#fbbf24', TAXI: '#f472b6', TRANSFER_DESK: '#22d3ee', OTHER: '#94a3b8',
};

const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');

/**
 * renderMap(el, opts)
 *  locations: [{code,name,type,x,y}]
 *  agents:    [{name, last_lat, last_lng, on_duty}]
 *  routes:    [{ points: [{lat,lng}], color, dashed, label }]  — GPS breadcrumb polylines
 *  lines:     [{ from:{x,y}, to:{x,y}, color }]                — planned straight legs
 *  highlight: [locationCode, ...]
 */
export function renderMap(el, { locations = [], agents = [], routes = [], lines = [], highlight = [] } = {}) {
  const parts = [];

  // terminal silhouette: two concourses + main hall
  parts.push(`
    <rect x="0" y="0" width="1000" height="600" fill="#0b1120"/>
    <path d="M 30 130 L 30 60 Q 30 30 60 30 L 470 30 Q 490 30 490 55 L 490 130 Z"
          fill="#131c2e" stroke="#233250" stroke-width="2"/>
    <path d="M 510 130 L 510 55 Q 510 30 530 30 L 940 30 Q 970 30 970 60 L 970 130 Z"
          fill="#131c2e" stroke="#233250" stroke-width="2"/>
    <rect x="60" y="130" width="880" height="130" rx="10" fill="#111a2b" stroke="#233250" stroke-width="2"/>
    <rect x="100" y="260" width="800" height="180" rx="10" fill="#131c2e" stroke="#233250" stroke-width="2"/>
    <rect x="220" y="440" width="560" height="150" rx="10" fill="#111a2b" stroke="#233250" stroke-width="2"/>
    <text x="500" y="205" fill="#31415e" font-size="26" font-weight="800" text-anchor="middle" letter-spacing="6">CONCOURSE WALKWAY</text>
    <text x="500" y="360" fill="#31415e" font-size="22" font-weight="800" text-anchor="middle" letter-spacing="5">TERMINAL 1</text>
    <text x="500" y="525" fill="#31415e" font-size="18" font-weight="800" text-anchor="middle" letter-spacing="4">ARRIVALS / LANDSIDE</text>
  `);

  // planned straight legs (dashed)
  for (const l of lines) {
    parts.push(`<line x1="${l.from.x}" y1="${l.from.y}" x2="${l.to.x}" y2="${l.to.y}"
      stroke="${l.color || '#3b82f6'}" stroke-width="3" stroke-dasharray="8 7" opacity="0.55"/>`);
  }

  // GPS breadcrumb polylines
  for (const r of routes) {
    const pts = r.points.map(p => llToXy(p.lat, p.lng)).map(p => `${p.x},${p.y}`).join(' ');
    if (!pts) continue;
    parts.push(`<polyline points="${pts}" fill="none" stroke="${r.color || '#22c55e'}"
      stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
  }

  // location dots
  for (const loc of locations) {
    const c = TYPE_COLORS[loc.type] || TYPE_COLORS.OTHER;
    const hl = highlight.includes(loc.code);
    parts.push(`
      <g>
        ${hl ? `<circle cx="${loc.x}" cy="${loc.y}" r="17" fill="none" stroke="${c}" stroke-width="2" opacity="0.7">
          <animate attributeName="r" values="12;20;12" dur="1.6s" repeatCount="indefinite"/>
        </circle>` : ''}
        <circle cx="${loc.x}" cy="${loc.y}" r="${hl ? 9 : 7}" fill="${c}" stroke="#0b1120" stroke-width="2"/>
        <text x="${loc.x}" y="${loc.y - 13}" fill="${hl ? c : '#7d8fae'}" font-size="13"
          font-weight="${hl ? 800 : 600}" text-anchor="middle">${esc(loc.code)}</text>
      </g>`);
  }

  // agents
  for (const a of agents) {
    if (a.last_lat == null) continue;
    const { x, y } = llToXy(a.last_lat, a.last_lng);
    if (x < -20 || x > 1020 || y < -20 || y > 620) continue; // outside airport bounds
    const initials = esc((a.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase());
    parts.push(`
      <g>
        <circle cx="${x}" cy="${y}" r="13" fill="#16a34a" stroke="#052e16" stroke-width="2.5"/>
        <text x="${x}" y="${y + 4.5}" fill="white" font-size="11" font-weight="800" text-anchor="middle">${initials}</text>
        <text x="${x}" y="${y + 28}" fill="#86efac" font-size="11" font-weight="600" text-anchor="middle">${esc(a.name)}</text>
      </g>`);
  }

  el.innerHTML = `<svg viewBox="0 0 1000 600" xmlns="http://www.w3.org/2000/svg"
    font-family="system-ui, sans-serif">${parts.join('')}</svg>`;
}
