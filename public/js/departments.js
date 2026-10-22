/* departments.js — hierarchy cards + CRUD */
let DEPTS = [];
let USER = null;
let EDIT_ID = null;
let EMPLOYEES = [];

(async function init() {
  USER = await requireAuth();
  buildShell('departments');
  render();
  await load();
  wireModals();
})();

function canManage() { return ['admin', 'hr'].includes(USER.role); }

async function load() {
  document.getElementById('page').innerHTML = skeletonRows(4);
  try {
    const [d, e] = await Promise.all([api('/departments'), api('/employees?status=active')]);
    DEPTS = d.departments;
    EMPLOYEES = e.employees;
    render();
  } catch { /* toast shown */ }
}

function render() {
  /* build hierarchy: roots (no parent) then children — indented by depth */
  const byParent = {};
  DEPTS.forEach(d => { const k = d.parent_id || '_root'; (byParent[k] = byParent[k] || []).push(d); });
  const ordered = [];
  const walk = (parentId, depth) => {
    (byParent[parentId || '_root'] || []).forEach(d => {
      ordered.push({ ...d, depth });
      walk(d.id, depth + 1);
    });
  };
  walk(null, 0);
  DEPTS.forEach(d => { if (!ordered.find(o => o.id === d.id)) ordered.push({ ...d, depth: 0 }); });

  const totalMembers = DEPTS.reduce((s, d) => s + (d.employee_count || 0), 0);
  document.getElementById('page').innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap">
      <div>
        <div style="font-size:15px;font-weight:800">${DEPTS.length} departments · ${totalMembers} people</div>
        <div class="card-sub">Organisation structure with nested sub-teams</div>
      </div>
      <div class="spacer" style="flex:1"></div>
      ${canManage() ? '<button class="btn btn-primary" id="add-dept"><i data-lucide="plus"></i> New Department</button>' : ''}
    </div>
    <div class="dept-grid">
      ${ordered.map((d, i) => deptCard(d, i)).join('') || '<div class="empty">No departments yet</div>'}
    </div>`;
  refreshLucide();
  if (canManage()) {
    document.getElementById('add-dept').onclick = () => openModalForm(null);
    document.querySelectorAll('[data-edit-dept]').forEach(b => b.onclick = () => openModalForm(b.dataset.editDept));
    document.querySelectorAll('[data-del-dept]').forEach(b => b.onclick = () => remove(b.dataset.delDept));
  }
}

function deptCard(d, i) {
  const headAvatar = d.head_name ? `<div class="avatar" style="background:${avatarColor(d.head_name)}">${initialsOf(d.head_name)}</div>` : '';
  return `
    <div class="card dept-card rise d${(i % 4) + 1}" style="margin-left:${Math.min(d.depth, 3) * 10}px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="dept-code">${esc(d.code)}</div>
          <h3>${esc(d.name)}</h3>
          <div class="parent-tag">${d.parent_name ? '↳ under ' + esc(d.parent_name) : d.depth ? '↳ sub-team' : 'top-level'}</div>
        </div>
        <div class="dot-ico" style="background:var(--grad-soft);color:var(--violet)"><i data-lucide="building-2"></i></div>
      </div>
      ${d.description ? `<div style="font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5">${esc(d.description)}</div>` : ''}
      <div class="dept-stats">
        <div><b>${d.employee_count ?? 0}</b><span>MEMBERS</span></div>
        <div style="display:flex;gap:9px;align-items:center">
          ${headAvatar}
          <div><b style="font-size:12.5px">${esc(d.head_name || '—')}</b><span>DEPT HEAD</span></div>
        </div>
      </div>
      ${canManage() ? `
        <div class="row-actions" style="margin-top:13px;justify-content:flex-start">
          <button class="btn btn-ghost btn-sm" data-edit-dept="${d.id}"><i data-lucide="pencil"></i> Edit</button>
          ${USER.role === 'admin' ? `<button class="btn btn-danger btn-sm" data-del-dept="${d.id}"><i data-lucide="trash-2"></i></button>` : ''}
        </div>` : ''}
    </div>`;
}

function openModalForm(dept) {
  EDIT_ID = dept ? dept.id : null;
  document.getElementById('dept-modal-title').textContent = dept ? `Edit — ${dept.name}` : 'New Department';
  const f = document.getElementById('dept-form');
  f.reset();
  document.getElementById('d-parent').innerHTML =
    '<option value="">— top level —</option>' +
    DEPTS.filter(d => !dept || d.id !== dept.id)
      .map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  document.getElementById('d-head').innerHTML =
    '<option value="">— none —</option>' +
    EMPLOYEES.map(e => `<option value="${e.id}">${esc(e.first_name)} ${esc(e.last_name)} (${esc(e.designation || '')})</option>`).join('');
  if (dept) {
    f.name.value = dept.name || '';
    f.code.value = dept.code || '';
    f.parent_id.value = dept.parent_id || '';
    f.head_id.value = dept.head_id || '';
    f.description.value = dept.description || '';
  }
  document.getElementById('dept-modal').classList.add('open');
  refreshLucide();
}

document.getElementById('dept-save')?.addEventListener('click', async () => {
  const f = document.getElementById('dept-form');
  const payload = {
    name: f.name.value.trim(), code: f.code.value.trim().toUpperCase(),
    parent_id: f.parent_id.value || null, head_id: f.head_id.value || null,
    description: f.description.value.trim(),
  };
  const btn = document.getElementById('dept-save');
  btn.disabled = true;
  try {
    if (EDIT_ID) { await api(`/departments/${EDIT_ID}`, { method: 'PUT', body: payload }); toast('Department updated', 'ok'); }
    else { const r = await api('/departments', { method: 'POST', body: payload }); toast(r.message || 'Created', 'ok'); }
    closeModal('dept-modal');
    await load();
  } catch { /* toast shown */ }
  btn.disabled = false;
});

async function remove(id) {
  const ok = await confirmDialog({
    title: 'Delete department?',
    text: 'Only possible when the department has no active members or sub-teams.',
    okText: 'Delete', danger: true,
  });
  if (!ok) return;
  try { await api(`/departments/${id}`, { method: 'DELETE' }); toast('Department deleted', 'ok'); load(); }
  catch { /* toast shown */ }
}
