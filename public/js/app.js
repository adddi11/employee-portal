/* ============================================================
   Zentra HR — shared shell: API client, auth guard, layout,
   formatters, toasts & modals. Loaded by every page.
   ============================================================ */

const Auth = {
  get token() { return localStorage.getItem('zt_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('zt_user') || 'null'); } catch { return null; } },
  save(token, user) {
    localStorage.setItem('zt_token', token);
    localStorage.setItem('zt_user', JSON.stringify(user));
  },
  clear() { localStorage.removeItem('zt_token'); localStorage.removeItem('zt_user'); },
};

/* ---------- API client ---------- */
async function api(path, { method = 'GET', body, headers = {}, silent = false } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(Auth.token ? { Authorization: `Bearer ${Auth.token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    Auth.clear();
    location.replace('login.html');
    throw new Error('Session expired');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty / non-JSON body */ }
  if (!res.ok) {
    const msg = data.error || (res.status >= 500
      ? 'Server unreachable — verify MONGODB_URI / deployment logs'
      : `Request failed (${res.status})`);
    const err = new Error(msg);
    err.status = res.status;
    if (!silent) toast(err.message, 'err');
    throw err;
  }
  return data;
}

/* ---------- auth guard for protected pages ---------- */
const ROLE_HOME = 'index.html';
const PAGE_ROLES = {
  'employees.html': ['admin', 'hr', 'manager'],
  'departments.html': ['admin', 'hr', 'manager'],
  'audit.html': ['admin', 'hr'],
};

async function requireAuth() {
  if (!Auth.token) { location.replace('login.html'); throw new Error('no auth'); }
  try {
    const me = await api('/auth/me', { silent: true });
    const u = {
      id: me.user.id, name: me.user.name, email: me.user.email, role: me.user.role,
      employee_id: me.user.employee_id,
      designation: me.employee?.designation || '',
      emp_code: me.employee?.emp_code || '',
    };
    Auth.save(Auth.token, u);
    const page = location.pathname.split('/').pop() || 'index.html';
    if (PAGE_ROLES[page] && !PAGE_ROLES[page].includes(u.role)) {
      location.replace(ROLE_HOME);
      throw new Error('forbidden');
    }
    return u;
  } catch (e) {
    if (e.status === 401) { location.replace('login.html'); }
    throw e;
  }
}

/* ---------- navigation config ---------- */
const NAV = [
  { section: 'Overview' },
  { key: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', href: 'index.html', roles: ['admin', 'hr', 'manager', 'employee'] },
  { section: 'Organisation' },
  { key: 'employees', label: 'Employees', icon: 'users', href: 'employees.html', roles: ['admin', 'hr', 'manager'] },
  { key: 'departments', label: 'Departments', icon: 'building-2', href: 'departments.html', roles: ['admin', 'hr', 'manager'] },
  { section: 'Operations' },
  { key: 'attendance', label: 'Attendance', icon: 'calendar-check', href: 'attendance.html', roles: ['admin', 'hr', 'manager', 'employee'] },
  { key: 'leaves', label: 'Leave Requests', icon: 'plane-takeoff', href: 'leaves.html', roles: ['admin', 'hr', 'manager', 'employee'], badge: true },
  { key: 'payroll', label: 'Payroll', icon: 'wallet', href: 'payroll.html', roles: ['admin', 'hr', 'manager', 'employee'] },
  { section: 'System' },
  { key: 'audit', label: 'Audit Trail', icon: 'scroll-text', href: 'audit.html', roles: ['admin', 'hr'] },
];

const PAGE_META = {
  dashboard: ['Command Center', 'Live pulse of your organisation'],
  employees: ['Employee Directory', 'Records, onboarding & team structure'],
  departments: ['Departments', 'Hierarchy, heads & headcount'],
  attendance: ['Attendance', 'Daily logs, check-ins & trends'],
  leaves: ['Leave Requests', 'Balances, applications & approvals'],
  payroll: ['Payroll', 'Salary runs & payslips'],
  audit: ['Audit Trail', 'Every sensitive action, recorded'],
};

function buildShell(activeKey) {
  const user = Auth.user || { name: '…', role: 'employee' };
  const nav = NAV.map((item) => {
    if (item.section) {
      return `<div class="nav-label">${item.section}</div>`;
    }
    if (!item.roles.includes(user.role)) return '';
    return `
      <a class="nav-item ${item.key === activeKey ? 'active' : ''}" href="${item.href}">
        <i data-lucide="${item.icon}"></i><span>${item.label}</span>
        ${item.badge ? '<span class="nav-badge" id="nav-pending" style="display:none">0</span>' : ''}
      </a>`;
  }).join('');

  const [title, subtitle] = PAGE_META[activeKey] || [activeKey, ''];
  const initials = initialsOf(user.name || user.email || '?');

  document.getElementById('app').innerHTML = `
    <aside class="sidebar dark-scroll" id="sidebar">
      <div class="brand">
        <div class="brand-mark">Z</div>
        <div><div class="brand-name">Zentra HR</div><div class="brand-sub">People Platform</div></div>
      </div>
      <nav class="nav-scroll">${nav}</nav>
      <div class="side-foot">
        <div class="user-chip">
          <div class="avatar" style="background:${avatarColor(user.name || 'U')}">${initials}</div>
          <div class="who"><b>${esc(user.name || 'User')}</b><span>${esc(String(user.role || '').toUpperCase())}</span></div>
          <button class="logout-btn" id="logout-btn" title="Log out"><i data-lucide="log-out"></i></button>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="hamburger" id="hamburger"><i data-lucide="menu"></i></button>
        <div class="page-head">
          <div class="page-title">${title}</div>
          <div class="page-sub">${subtitle}</div>
        </div>
        <div class="top-actions">
          <div class="date-chip"><i data-lucide="calendar-days"></i><span id="today-chip"></span></div>
          <button class="bell-btn" id="bell" title="Pending approvals">
            <i data-lucide="bell"></i><span class="dot" id="bell-count" style="display:none">0</span>
          </button>
          <div class="me-chip">
            <div class="avatar sm" style="background:${avatarColor(user.name || 'U')}">${initials}</div>
            <div class="me-txt"><b>${esc(user.name || '')}</b><span>${esc(String(user.role || '').toUpperCase())}</span></div>
          </div>
        </div>
      </header>
      <main class="content" id="page"></main>
    </div>
    <div class="toasts" id="toasts"></div>`;

  const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  document.getElementById('today-chip').textContent =
    new Date().toLocaleDateString('en-IN', opts);

  document.getElementById('logout-btn').onclick = () => { Auth.clear(); location.replace('login.html'); };
  document.getElementById('bell').onclick = () => { location.href = 'leaves.html'; };
  const ham = document.getElementById('hamburger');
  if (ham) ham.onclick = () => document.getElementById('sidebar').classList.toggle('open');

  refreshLucide();
  loadPendingBadge();
}

async function loadPendingBadge() {
  try {
    const { count } = await api('/leaves/pending/count', { silent: true });
    const bell = document.getElementById('bell-count');
    const navBadge = document.getElementById('nav-pending');
    if (bell && count > 0) { bell.style.display = 'grid'; bell.textContent = count > 99 ? '99+' : count; }
    if (navBadge && count > 0) { navBadge.style.display = 'grid'; navBadge.textContent = count; }
  } catch { /* ignore */ }
}

/* ---------- formatters ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function initialsOf(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}
const AV_COLORS = ['#7c3aed', '#0ea5e9', '#14b8a6', '#f59e0b', '#f43f5e', '#8b5cf6', '#ec4899', '#10b981'];
function avatarColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return AV_COLORS[h % AV_COLORS.length];
}
function money(n) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0);
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function relTime(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
const STATUS_BADGES = {
  active: 'b-green', approved: 'b-green', present: 'b-green', completed: 'b-green',
  pending: 'b-amber', late: 'b-amber', processing: 'b-amber',
  rejected: 'b-red', absent: 'b-red', inactive: 'b-red', disabled: 'b-red',
  cancelled: 'b-gray', wfh: 'b-sky', leave: 'b-violet', draft: 'b-gray',
};
function badge(status) {
  const cls = STATUS_BADGES[String(status || '').toLowerCase()] || 'b-gray';
  return `<span class="badge ${cls}">${esc(String(status || '—').replace('_', ' '))}</span>`;
}
function roleBadge(role) {
  const map = { admin: 'b-violet', hr: 'b-teal', manager: 'b-sky', employee: 'b-gray' };
  return `<span class="badge plain ${map[role] || 'b-gray'}">${esc(String(role || '').toUpperCase())}</span>`;
}
function leaveTypeLabel(t) { return { annual: 'Annual', sick: 'Sick', casual: 'Casual' }[t] || t; }

/* ---------- toasts ---------- */
function toast(msg, type = 'ok') {
  const wrap = document.getElementById('toasts');
  if (!wrap) { console.log('[toast]', msg); return; }
  const icons = { ok: 'check-circle-2', err: 'alert-circle', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i data-lucide="${icons[type] || 'info'}"></i><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  refreshLucide();
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(24px)'; el.style.transition = '.3s'; }, 3400);
  setTimeout(() => el.remove(), 3800);
}

/* ---------- modal helpers ---------- */
function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function wireModals() {
  document.querySelectorAll('.modal-back').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => m.classList.remove('open'); });
  });
}

/* ---------- confirm dialog (promise-based) ---------- */
function confirmDialog({ title = 'Are you sure?', text = '', okText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const id = 'confirm-modal-' + Date.now();
    const back = document.createElement('div');
    back.className = 'modal-back open'; back.id = id;
    back.innerHTML = `
      <div class="modal" style="max-width:410px">
        <div class="modal-head"><div><div class="modal-title">${esc(title)}</div></div></div>
        <div class="modal-body"><p style="color:var(--ink-2);font-size:13.5px">${esc(text)}</p></div>
        <div class="modal-foot">
          <button class="btn btn-ghost" id="${id}-no">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="${id}-yes">${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    back.querySelector(`#${id}-no`).onclick = () => { back.remove(); resolve(false); };
    back.querySelector(`#${id}-yes`).onclick = () => { back.remove(); resolve(true); };
    back.addEventListener('click', (e) => { if (e.target === back) { back.remove(); resolve(false); } });
  });
}

/* ---------- misc ---------- */
function refreshLucide() { if (window.lucide) lucide.createIcons(); }
function countUp(el, target, { dur = 900, money: isMoney = false } = {}) {
  const start = performance.now();
  const from = 0;
  function frame(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = Math.round(from + (target - from) * eased);
    el.textContent = isMoney ? money(v) : v.toLocaleString('en-IN');
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function skeletonRows(n = 5) {
  return `<div style="display:grid;gap:12px">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
