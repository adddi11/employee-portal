/* audit.js — searchable, filterable audit trail (admin / hr only) */
let ACTIONS = [];
let FILTER = { action: '', q: '' };

(async function init() {
  await requireAuth();
  buildShell('audit');
  renderPage();
  await load();
})();

function renderPage() {
  document.getElementById('page').innerHTML = `
    <div class="card table-card rise">
      <div class="table-toolbar">
        <div class="input" style="max-width:240px;display:flex;align-items:center;gap:8px;padding:0 12px">
          <i data-lucide="search" style="width:15px;height:15px;color:var(--muted)"></i>
          <input id="a-q" placeholder="Search actor…" style="border:none;outline:none;background:none;width:100%;padding:9.5px 0;font-family:inherit;font-size:13px" />
        </div>
        <select id="a-action" class="input" style="max-width:230px">
          <option value="">All actions</option>
        </select>
        <div class="spacer"></div>
        <button class="btn btn-ghost btn-sm" id="a-refresh"><i data-lucide="refresh-cw"></i> Refresh</button>
      </div>
      <div class="table-scroll"><div id="audit-wrap">${skeletonRows(8)}</div></div>
    </div>`;
  document.getElementById('a-q').addEventListener('input', debounce(() => {
    FILTER.q = document.getElementById('a-q').value; load();
  }, 350));
  document.getElementById('a-action').onchange = (e) => { FILTER.action = e.target.value; load(); };
  document.getElementById('a-refresh').onclick = load;
  refreshLucide();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

const ACTION_COLORS = {
  LOGIN: 'b-sky', LOGIN_FAILED: 'b-red', LOGOUT: 'b-gray',
  LEAVE_APPLIED: 'b-violet', LEAVE_APPROVED: 'b-green', LEAVE_REJECTED: 'b-red',
  LEAVE_CANCELLED: 'b-gray',
  PAYROLL_RUN_EXECUTED: 'b-teal',
  EMPLOYEE_ONBOARDED: 'b-green', EMPLOYEE_UPDATED: 'b-amber', EMPLOYEE_DEACTIVATED: 'b-red',
  DEPARTMENT_CREATED: 'b-violet', DEPARTMENT_UPDATED: 'b-amber', DEPARTMENT_DELETED: 'b-red',
  ATTENDANCE_CHECKIN: 'b-sky', ATTENDANCE_CHECKOUT: 'b-sky',
  PASSWORD_CHANGED: 'b-amber', ACCOUNT_ROLE_CHANGED: 'b-amber',
  SYSTEM_SEEDED: 'b-gray',
};

async function load() {
  const wrap = document.getElementById('audit-wrap');
  if (!wrap) return;
  try {
    const params = new URLSearchParams({ limit: 150 });
    if (FILTER.action) params.set('action', FILTER.action);
    if (FILTER.q) params.set('q', FILTER.q);
    const { logs, actions } = await api('/audit?' + params.toString());
    if (actions && ACTIONS.length !== actions.length) {
      ACTIONS = actions;
      const sel = document.getElementById('a-action');
      const current = sel.value;
      sel.innerHTML = '<option value="">All actions</option>' +
        actions.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
      sel.value = current;
    }
    if (!logs.length) {
      wrap.innerHTML = '<div class="empty"><i data-lucide="scroll-text"></i><b>No audit entries</b>Adjust the filters above.</div>';
      refreshLucide(); return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>
          ${logs.map(l => `
            <tr>
              <td style="white-space:nowrap"><b style="font-size:12.5px">${relTime(l.created_at)}</b>
                <div class="cell-sub">${fmtDateTime(l.created_at)}</div></td>
              <td>
                <div style="display:flex;align-items:center;gap:9px">
                  <div class="avatar sm" style="background:${avatarColor(l.actor_name || 'system')}">${initialsOf(l.actor_name || 'S')}</div>
                  <div><div class="cell-main" style="font-size:13px">${esc(l.actor_name || 'system')}</div>
                  <div class="cell-sub">${roleBadge(l.actor_role)}</div></div>
                </div>
              </td>
              <td><span class="badge plain ${ACTION_COLORS[l.action] || 'b-gray'}">${esc(l.action)}</span></td>
              <td class="cell-sub">${esc(l.entity_type || '—')}${l.entity_id ? `<br/><span class="cell-mono" style="font-size:10px">${esc(l.entity_id.slice(0, 12))}…</span>` : ''}</td>
              <td style="max-width:280px"><span class="cell-sub" style="font-size:11.5px">${esc(detailsSummary(l.details))}</span></td>
              <td class="cell-mono" style="font-size:11px">${esc(l.ip || '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    refreshLucide();
  } catch {
    wrap.innerHTML = '<div class="empty">Could not load audit trail</div>';
  }
}

function detailsSummary(d) {
  if (!d || typeof d !== 'object') return '—';
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ') || '—';
}
