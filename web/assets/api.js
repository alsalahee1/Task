// Shared frontend API helper: auth, requests, live stream, toasts.
import { t } from '/assets/i18n.js';

export const API = {
  get token() { return localStorage.getItem('aero_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('aero_user')); } catch { return null; } },

  async req(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && path !== '/api/login') {
      localStorage.removeItem('aero_token');
      location.href = '/';
      throw new Error('Session expired');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get(path) { return this.req('GET', path); },
  post(path, body) { return this.req('POST', path, body); },
  put(path, body) { return this.req('PUT', path, body); },

  async login(username, password) {
    const data = await this.req('POST', '/api/login', { username, password });
    localStorage.setItem('aero_token', data.token);
    localStorage.setItem('aero_user', JSON.stringify(data.user));
    return data.user;
  },

  async logout() {
    try { await this.post('/api/logout'); } catch { /* already invalid */ }
    localStorage.removeItem('aero_token');
    localStorage.removeItem('aero_user');
    location.href = '/';
  },

  requireRole(role) {
    if (!this.token || !this.user || this.user.role !== role) {
      location.href = '/';
      throw new Error('redirecting to login');
    }
    return this.user;
  },

  // Live updates via SSE; auto-reconnects. handlers = { task(t), agent(a) }
  stream(handlers) {
    const es = new EventSource(`/api/stream?token=${this.token}`);
    for (const [event, fn] of Object.entries(handlers))
      es.addEventListener(event, e => fn(JSON.parse(e.data)));
    return es;
  },
};

export function toast(msg, isError = false) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isError ? 'err' : '';
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 3200);
}

export const esc = s => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export function fmtMin(m) {
  if (m == null) return '—';
  if (m < 1) return `${Math.round(m * 60)}s`;
  return `${Math.round(m * 10) / 10} min`;
}

// SLA pill: countdown before pickup, then final met/breached state.
export function slaPill(task) {
  if (task.status === 'CANCELLED') return '';
  if (task.sla_met === 1) return `<span class="sla-pill green">${t('sla_met')}</span>`;
  if (task.sla_met === 0) return `<span class="sla-pill red">${t('sla_breached')}</span>`;
  if (['COMPLETED'].includes(task.status)) return '';
  const msLeft = new Date(task.sla_deadline_at) - Date.now();
  const total = task.sla_target_minutes * 60000 || 1;
  const mins = Math.floor(Math.abs(msLeft) / 60000);
  const secs = Math.floor((Math.abs(msLeft) % 60000) / 1000);
  const clock = `${mins}:${String(secs).padStart(2, '0')}`;
  if (msLeft <= 0) return `<span class="sla-pill red">${t('overdue')} ${clock}</span>`;
  const cls = msLeft / total > 0.5 ? 'green' : 'amber';
  return `<span class="sla-pill ${cls}">⏱ ${clock}</span>`;
}
