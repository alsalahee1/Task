// Schematic SVG airport map (1000x600 map units).
// GPS lat/lng ↔ map x/y linear transform; fetched from /api/config at boot so it
// always matches the server (which refits it when a real airport is imported).
let REF = { ax: 1e5, bx: -5536000, ay: -1e5, by: 2525600 };
let floorplanUrl = null;

export const llToXy = (lat, lng) => ({ x: REF.ax * lng + REF.bx, y: REF.ay * lat + REF.by });

// Call once at boot: syncs the projection and detects a real floor-plan image
// (drop your terminal plan at web/assets/floorplan.png to replace the schematic).
export async function initMap(api) {
  try {
    const cfg = await api.get('/api/config');
    if (cfg.map_ref) REF = cfg.map_ref;
  } catch { /* keep defaults */ }
  try {
    const head = await fetch('/assets/floorplan.png', { method: 'HEAD' });
    if (head.ok) floorplanUrl = '/assets/floorplan.png';
  } catch { /* no floor plan */ }
}

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

  parts.push(`<rect x="0" y="0" width="1000" height="600" fill="#0b1120"/>`);
  if (floorplanUrl) {
    // real terminal floor plan as background, dimmed to keep overlays readable
    parts.push(`<image href="${floorplanUrl}" x="0" y="0" width="1000" height="600"
      preserveAspectRatio="xMidYMid meet" opacity="0.45"/>`);
  } else {
    // generic terminal silhouette: two concourses + main hall
    parts.push(`
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
  }

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

  // location dots (skip anything projected outside the view, e.g. leftovers
  // from a previous airport after a re-import)
  for (const loc of locations) {
    if (loc.x < -20 || loc.x > 1020 || loc.y < -20 || loc.y > 620) continue;
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
