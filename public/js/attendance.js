/* attendance.js — check-in/out, monthly log with role scoping */
let USER = null;
let MONTH = new Date().toISOString().slice(0, 7);
let FILTERS = { employee_id: '', status: '' };

(async function init() {
  USER = await requireAuth();
  buildShell('attendance');
  renderPage();
  await Promise.all([loadToday(), loadLog()]);
})();

function canSeeAll() { return ['admin', 'hr', 'manager'].includes(USER.role); }

function renderPage() {
  const now = new Date();
  document.getElementById('page').innerHTML = `
    <div class="grid" style="grid-template-columns:340px 1fr;margin-bottom:18px" id="top-grid">
      <div class="card rise d1" id="today-card">${skeletonRows(3)}</div>
      <div class="card table-card rise d2" style="overflow:hidden">
        <div class="table-toolbar">
          <input type="month" id="month-pick" class="input" style="max-width:170px" value="${MONTH}" />
          ${canSeeAll() ? '<select id="emp-filter" class="input" style="max-width:210px"></select>' : ''}
          <select id="status-filter" class="input" style="max-width:150px">
            <option value="">All statuses</option>
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="wfh">WFH</option>
            <option value="absent">Absent</option>
            <option value="leave">On leave</option>
          </select>
          <div class="spacer"></div>
          <div id="log-summary" style="display:flex;gap:8px;flex-wrap:wrap"></div>
        </div>
        <div class="table-scroll"><div id="log-wrap">${skeletonRows(6)}</div></div>
      </div>
    </div>`;
  if (window.matchMedia('(max-width: 1100px)').matches) {
    document.getElementById('top-grid').style.gridTemplateColumns = '1fr';
  }
  document.getElementById('month-pick').onchange = (e) => { MONTH = e.target.value; loadLog(); };
  document.getElementById('status-filter').onchange = (e) => { FILTERS.status = e.target.value; loadLog(); };
  if (canSeeAll()) {
    loadEmployeeFilter();
  }
  refreshLucide();
}

async function loadEmployeeFilter() {
  try {
    const { employees } = await api('/employees');
    const sel = document.getElementById('emp-filter');
    sel.innerHTML = `<option value="">${USER.role === 'manager' ? 'Me + my team' : 'Everyone'}</option>` +
      employees.filter(e => e.status === 'active').map(e =>
        `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)}</option>`).join('');
    sel.onchange = () => { FILTERS.employee_id = sel.value; loadLog(); };
  } catch { /* ignore */ }
}

async function loadToday() {
  const el = document.getElementById('today-card');
  try {
    const { attendance: rec } = await api('/attendance/today');
    const checkedIn = !!rec?.check_in;
    const checkedOut = !!rec?.check_out;
    const now = new Date();
    el.innerHTML = `
      <div class="card-head"><div>
        <div class="card-title"><i data-lucide="clock-4"></i> Today</div>
        <div class="card-sub">${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div></div>
      <div style="text-align:center;padding:6px 0 14px">
        <div style="font-size:44px;font-weight:800;letter-spacing:-1.5px;font-variant-numeric:tabular-nums" id="live-clock">
          ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}
        </div>
        <div class="card-sub">${rec?.status ? badge(rec.status) : 'Not checked in yet'}</div>
      </div>
      <div style="display:flex;justify-content:space-around;padding:10px 0;border-top:1px dashed var(--line);border-bottom:1px dashed var(--line);margin-bottom:16px">
        <div style="text-align:center">
          <div class="card-sub" style="letter-spacing:1px">CHECK IN</div>
          <b style="font-size:15px">${fmtTime(rec?.check_in)}</b>
        </div>
        <div style="width:1px;background:var(--line)"></div>
        <div style="text-align:center">
          <div class="card-sub" style="letter-spacing:1px">CHECK OUT</div>
          <b style="font-size:15px">${fmtTime(rec?.check_out)}</b>
        </div>
        <div style="width:1px;background:var(--line)"></div>
        <div style="text-align:center">
          <div class="card-sub" style="letter-spacing:1px">HOURS</div>
          <b style="font-size:15px">${rec?.hours_worked != null ? rec.hours_worked + 'h' : '—'}</b>
        </div>
      </div>
      <button class="btn ${checkedIn && !checkedOut ? 'btn-ghost' : 'btn-primary'}" id="punch-btn" style="width:100%">
        <i data-lucide="${checkedIn ? (checkedOut ? 'check-circle-2' : 'log-out') : 'log-in'}"></i>
        ${checkedIn ? (checkedOut ? 'Day complete — see you tomorrow!' : 'Check out') : 'Check in'}
      </button>`;
    refreshLucide();
    const btn = document.getElementById('punch-btn');
    if (checkedIn && checkedOut) { btn.disabled = true; }
    else btn.onclick = punch;
  } catch {
    el.innerHTML = '<div class="empty">Could not load today\'s attendance</div>';
  }
}

setInterval(() => {
  const el = document.getElementById('live-clock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}, 1000);

async function punch() {
  try {
    const checkedIn = !!document.querySelector('#today-card')?.textContent.includes('CHECK IN') &&
      !document.getElementById('punch-btn').textContent.includes('Check in');
    const path = document.getElementById('punch-btn').textContent.includes('Check out') ? '/attendance/check-out' : '/attendance/check-in';
    const res = await api(path, { method: 'POST', body: {} });
    toast(res.message || 'Done', 'ok');
    loadToday();
  } catch { /* toast shown */ }
}

async function loadLog() {
  const wrap = document.getElementById('log-wrap');
  if (!wrap) return;
  try {
    const params = new URLSearchParams({ month: MONTH });
    if (FILTERS.employee_id) params.set('employee_id', FILTERS.employee_id);
    if (FILTERS.status) params.set('status', FILTERS.status);
    const { attendance: rows, summary } = await api('/attendance?' + params.toString());
    const sumEl = document.getElementById('log-summary');
    if (sumEl) {
      sumEl.innerHTML = [
        ['Present', summary.present || 0, 'b-green'],
        ['WFH', summary.wfh || 0, 'b-sky'],
        ['Late', summary.late || 0, 'b-amber'],
        ['Absent', (summary.absent || 0) + (summary.leave || 0), 'b-red'],
      ].map(([l, v, c]) => `<span class="badge plain ${c}">${l}: ${v}</span>`).join('');
    }
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty"><i data-lucide="calendar-x"></i><b>No records</b>Nothing logged for this period.</div>';
      refreshLucide(); return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Date</th>${canSeeAll() ? '<th>Employee</th>' : ''}<th>Status</th>
          <th>Check in</th><th>Check out</th><th class="num">Hours</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><b>${fmtDate(r.date)}</b></td>
              ${canSeeAll() ? `<td>
                <div style="display:flex;align-items:center;gap:9px">
                  <div class="avatar sm" style="background:${avatarColor(r.employee_name || '?')}">${initialsOf(r.employee_name)}</div>
                  <span>${esc(r.employee_name || '—')}</span>
                </div></td>` : ''}
              <td>${badge(r.status)}</td>
              <td class="cell-mono">${fmtTime(r.check_in)}</td>
              <td class="cell-mono">${fmtTime(r.check_out)}</td>
              <td class="num cell-main">${r.hours_worked != null ? r.hours_worked + 'h' : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    refreshLucide();
  } catch {
    wrap.innerHTML = '<div class="empty">Could not load attendance log</div>';
  }
}
