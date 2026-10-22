/* employees.js — directory, onboarding, edit, soft-delete */
let STATE = { employees: [], departments: [], q: '', dept: '', status: 'active' };
let EDIT_ID = null;
let USER = null;

(async function init() {
  USER = await requireAuth();
  buildShell('employees');
  const canManage = ['admin', 'hr'].includes(USER.role);
  renderShellMarkup(canManage);
  await loadFilters();
  await load();
  wireModals();
})();

function renderShellMarkup(canManage) {
  document.getElementById('page').innerHTML = `
    <div class="card table-card rise">
      <div class="table-toolbar">
        <div class="input" style="max-width:250px;display:flex;align-items:center;gap:8px;padding:0 12px">
          <i data-lucide="search" style="width:15px;height:15px;color:var(--muted)"></i>
          <input id="q" placeholder="Search name, email, code…" style="border:none;outline:none;background:none;width:100%;padding:9.5px 0;font-family:inherit;font-size:13px" />
        </div>
        <select id="f-dept-filter" class="input" style="max-width:190px"></select>
        <div class="seg" id="status-seg">
          <button data-v="active" class="on">Active</button>
          <button data-v="inactive">Inactive</button>
          <button data-v="">All</button>
        </div>
        <div class="spacer"></div>
        ${canManage ? '<button class="btn btn-primary" id="add-btn"><i data-lucide="user-plus"></i> Onboard Employee</button>' : ''}
      </div>
      <div class="table-scroll"><div id="table-wrap">${skeletonRows(6)}</div></div>
    </div>`;

  document.getElementById('q').addEventListener('input', debounce(() => {
    STATE.q = document.getElementById('q').value; load();
  }, 350));
  document.getElementById('f-dept-filter').onchange = (e) => { STATE.dept = e.target.value; load(); };
  document.getElementById('status-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#status-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    STATE.status = b.dataset.v; load();
  };
  if (canManage) document.getElementById('add-btn').onclick = () => openOnboard();
  refreshLucide();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

async function loadFilters() {
  try {
    const deps = await api('/departments');
    STATE.departments = deps.departments;
    const sel = document.getElementById('f-dept-filter');
    sel.innerHTML = '<option value="">All departments</option>' +
      deps.departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    const fd = document.getElementById('f-dept');
    const fm = document.getElementById('f-mgr');
    if (fd) fd.innerHTML = '<option value="">— none —</option>' +
      deps.departments.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    if (fm) fm.innerHTML = '<option value="">— none —</option>';
  } catch { /* toast shown */ }
}

async function load() {
  const wrap = document.getElementById('table-wrap');
  if (!wrap) return;
  try {
    const params = new URLSearchParams();
    if (STATE.q) params.set('q', STATE.q);
    if (STATE.dept) params.set('department_id', STATE.dept);
    if (STATE.status) params.set('status', STATE.status);
    const data = await api('/employees?' + params.toString());
    STATE.employees = data.employees;
    renderTable();
  } catch { wrap.innerHTML = '<div class="empty">Could not load employees</div>'; }
}

function renderTable() {
  const canManage = ['admin', 'hr'].includes(USER.role);
  const rows = STATE.employees;
  const wrap = document.getElementById('table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty"><i data-lucide="users"></i><b>No employees found</b>Try adjusting the filters.</div>';
    refreshLucide(); return;
  }
  wrap.innerHTML = `
    <table>
      <thead><tr>
        <th>Employee</th><th>Code</th><th>Department</th><th>Designation</th><th>Reports to</th>
        ${canManage ? '<th class="num">Salary</th>' : ''}
        <th>Joined</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(e => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:11px">
                <div class="avatar" style="background:${avatarColor(e.first_name + ' ' + e.last_name)}">${initialsOf(e.first_name + ' ' + e.last_name)}</div>
                <div><div class="cell-main">${esc(e.first_name)} ${esc(e.last_name)}</div>
                <div class="cell-sub">${esc(e.email || '')}</div></div>
              </div>
            </td>
            <td class="cell-mono">${esc(e.emp_code)}</td>
            <td>${esc(e.department_name || '—')}</td>
            <td>${esc(e.designation || '—')}</td>
            <td>${esc(e.manager_name || '—')}</td>
            ${canManage ? `<td class="num cell-main">${money(e.salary)}</td>` : ''}
            <td>${fmtDate(e.join_date)}</td>
            <td>${badge(e.status)}</td>
            <td><div class="row-actions">
              <button class="btn btn-ghost btn-sm" data-view="${e.id}" title="View"><i data-lucide="eye"></i></button>
              ${canManage ? `<button class="btn btn-ghost btn-sm" data-edit="${e.id}" title="Edit"><i data-lucide="pencil"></i></button>
              ${USER.role === 'admin' ? `<button class="btn btn-danger btn-sm" data-del="${e.id}" title="Deactivate"><i data-lucide="user-x"></i></button>` : ''}` : ''}
            </div></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  refreshLucide();

  wrap.querySelectorAll('[data-view]').forEach(b => b.onclick = () => viewEmp(b.dataset.view));
  wrap.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEdit(b.dataset.edit));
  wrap.querySelectorAll('[data-del]').forEach(b => b.onclick = () => softDelete(b.dataset.del));
}

/* ---------- onboarding ---------- */
function openOnboard() {
  EDIT_ID = null;
  document.getElementById('emp-modal-title').textContent = 'Onboard Employee';
  document.getElementById('emp-modal-sub').textContent = 'Creates the record and a login account atomically';
  const f = document.getElementById('emp-form');
  f.reset();
  document.getElementById('f-role').disabled = USER.role !== 'admin';
  document.getElementById('emp-save').innerHTML = '<i data-lucide="user-plus"></i> Onboard';
  document.getElementById('emp-modal').classList.add('open');
  refreshLucide();
}

async function openEdit(id) {
  try {
    const { employee: e } = await api(`/employees/${id}`);
    EDIT_ID = id;
    document.getElementById('emp-modal-title').textContent = `Edit — ${e.first_name} ${e.last_name}`;
    document.getElementById('emp-modal-sub').textContent = 'Changes are audit-logged';
    const f = document.getElementById('emp-form');
    f.first_name.value = e.first_name || '';
    f.last_name.value = e.last_name || '';
    f.email.value = e.email || '';
    f.email.disabled = true;
    f.phone.value = e.phone || '';
    f.department_id.value = e.department_id || '';
    await fillManagers(e.department_id, e.manager_id);
    f.designation.value = e.designation || '';
    f.employment_type.value = e.employment_type || 'full_time';
    f.join_date.value = e.join_date || '';
    f.salary.value = e.salary ?? '';
    f.annual.value = e.leave_balances?.annual ?? 20;
    f.sick.value = e.leave_balances?.sick ?? 12;
    f.casual.value = e.leave_balances?.casual ?? 8;
    document.getElementById('f-role').disabled = USER.role !== 'admin';
    document.getElementById('emp-save').innerHTML = '<i data-lucide="save"></i> Save changes';
    document.getElementById('emp-modal').classList.add('open');
    refreshLucide();
  } catch { /* toast shown */ }
}

async function fillManagers(deptId, selected) {
  const fm = document.getElementById('f-mgr');
  let list = STATE.employees;
  try {
    const params = new URLSearchParams();
    if (STATE.status === '') params.set('status', '');
    const data = await api('/employees?' + params.toString());
    list = data.employees;
  } catch { /* fallback to current */ }
  const options = ['<option value="">— none —</option>']
    .concat(list.filter(e => e.status === 'active').map(e =>
      `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)} (${esc(e.designation || '—')})</option>`));
  fm.innerHTML = options.join('');
  if (selected) fm.value = selected;
}

document.getElementById('emp-form')?.addEventListener('submit', e => e.preventDefault());
document.getElementById('emp-save')?.addEventListener('click', async () => {
  const f = document.getElementById('emp-form');
  const payload = {
    first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim(),
    email: f.email.value.trim().toLowerCase(), phone: f.phone.value.trim(),
    department_id: f.department_id.value || null,
    manager_id: f.manager_id.value || null,
    designation: f.designation.value.trim(), employment_type: f.employment_type.value,
    join_date: f.join_date.value, salary: Number(f.salary.value),
    leave_balances: { annual: Number(f.annual.value), sick: Number(f.sick.value), casual: Number(f.casual.value) },
  };
  const btn = document.getElementById('emp-save');
  btn.disabled = true;
  try {
    if (EDIT_ID) {
      if (USER.role === 'admin' && f.account_role.value) payload.account_role = f.account_role.value;
      await api(`/employees/${EDIT_ID}`, { method: 'PUT', body: payload });
      toast('Employee updated', 'ok');
    } else {
      payload.account_role = f.account_role.value;
      payload.password = f.password.value;
      const res = await api('/employees', { method: 'POST', body: payload });
      toast(res.message || 'Onboarded', 'ok');
    }
    closeModal('emp-modal');
    await load();
  } catch { /* toast shown */ }
  btn.disabled = false;
});

document.getElementById('f-dept')?.addEventListener('change', (e) => fillManagers(e.target.value, null));

async function viewEmp(id) {
  try {
    const { employee: e } = await api(`/employees/${id}`);
    const canSeeSalary = ['admin', 'hr'].includes(USER.role);
    document.getElementById('view-body').innerHTML = `
      <div style="display:flex;gap:15px;align-items:center;margin-bottom:18px">
        <div class="avatar lg" style="background:${avatarColor(e.first_name + ' ' + e.last_name)}">${initialsOf(e.first_name + ' ' + e.last_name)}</div>
        <div>
          <div style="font-size:17px;font-weight:800">${esc(e.first_name)} ${esc(e.last_name)}</div>
          <div style="color:var(--muted);font-size:12.5px">${esc(e.designation || '')} · ${esc(e.department_name || 'Unassigned')}</div>
          <div style="margin-top:5px">${badge(e.status)} <span class="cell-mono">${esc(e.emp_code)}</span></div>
        </div>
      </div>
      <div class="form-grid" style="gap:10px">
        <div><div class="card-sub">Email</div><b style="font-size:13.5px">${esc(e.email || '—')}</b></div>
        <div><div class="card-sub">Phone</div><b style="font-size:13.5px">${esc(e.phone || '—')}</b></div>
        <div><div class="card-sub">Reports to</div><b style="font-size:13.5px">${esc(e.manager_name || '—')}</b></div>
        <div><div class="card-sub">Joined</div><b style="font-size:13.5px">${fmtDate(e.join_date)}</b></div>
        ${canSeeSalary ? `<div><div class="card-sub">Monthly salary</div><b style="font-size:13.5px">${money(e.salary)}</b></div>
        <div><div class="card-sub">Employment</div><b style="font-size:13.5px">${esc((e.employment_type || '').replace('_', ' '))}</b></div>
        <div><div class="card-sub">Leave balance</div><b style="font-size:13.5px">Annual ${e.leave_balances?.annual ?? '—'} · Sick ${e.leave_balances?.sick ?? '—'} · Casual ${e.leave_balances?.casual ?? '—'}</b></div>` : ''}
      </div>`;
    document.getElementById('view-modal').classList.add('open');
  } catch { /* toast shown */ }
}

async function softDelete(id) {
  const ok = await confirmDialog({
    title: 'Deactivate employee?',
    text: 'The record and history are preserved; their login will be disabled immediately.',
    okText: 'Deactivate', danger: true,
  });
  if (!ok) return;
  try {
    await api(`/employees/${id}`, { method: 'DELETE' });
    toast('Employee deactivated (soft delete)', 'ok');
    load();
  } catch { /* toast shown */ }
}
