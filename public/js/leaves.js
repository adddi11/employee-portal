/* leaves.js — balances, apply (idempotent), review (approve/reject) */
let USER = null;
let SCOPE = 'mine';
let STATUS = '';
let BALANCES = null;
let CAN_REVIEW = false;

(async function init() {
  USER = await requireAuth();
  buildShell('leaves');
  CAN_REVIEW = ['admin', 'hr', 'manager'].includes(USER.role);
  const params = new URLSearchParams(location.search);
  if (params.get('scope') === 'team' && CAN_REVIEW) SCOPE = 'team';
  renderPage();
  await Promise.all([loadBalances(), loadLeaves()]);
  wireModals();
  if (params.get('apply') === '1') openApply();
})();

function renderPage() {
  document.getElementById('page').innerHTML = `
    <div class="grid" style="grid-template-columns:320px 1fr" id="leaves-grid">
      <div style="display:grid;gap:18px;align-content:start">
        <div class="card rise d1" id="bal-card">${skeletonRows(2)}</div>
        <div class="card rise d2">
          <div class="card-head"><div>
            <div class="card-title"><i data-lucide="info"></i> How approvals work</div>
          </div></div>
          <div style="font-size:12.5px;color:var(--ink-2);line-height:1.7">
            Requests are reviewed by your reporting manager (or HR).
            Balances deduct atomically the moment an approval lands —
            concurrent approvals can never overdraw your balance.
          </div>
        </div>
      </div>
      <div class="card table-card rise d2" style="overflow:hidden">
        <div class="table-toolbar">
          <div class="seg" id="scope-seg">
            <button data-v="mine" class="${SCOPE === 'mine' ? 'on' : ''}">Mine</button>
            ${CAN_REVIEW ? `<button data-v="team" class="${SCOPE === 'team' ? 'on' : ''}">Team</button>` : ''}
            ${['admin', 'hr'].includes(USER.role) ? `<button data-v="all" class="${SCOPE === 'all' ? 'on' : ''}">Everyone</button>` : ''}
          </div>
          <select id="status-filter" class="input" style="max-width:150px">
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="apply-btn"><i data-lucide="plane-takeoff"></i> Apply for leave</button>
        </div>
        <div class="table-scroll"><div id="leaves-wrap">${skeletonRows(6)}</div></div>
      </div>
    </div>`;
  if (window.matchMedia('(max-width: 1100px)').matches) {
    document.getElementById('leaves-grid').style.gridTemplateColumns = '1fr';
  }
  document.getElementById('scope-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    document.querySelectorAll('#scope-seg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); SCOPE = b.dataset.v; loadLeaves();
  };
  document.getElementById('status-filter').onchange = (e) => { STATUS = e.target.value; loadLeaves(); };
  document.getElementById('apply-btn').onclick = openApply;
  refreshLucide();
}

async function loadBalances() {
  const el = document.getElementById('bal-card');
  try {
    const { balances } = await api('/leaves/balances/me');
    BALANCES = balances;
    const ring = (label, b, color, max) => {
      const pct = Math.max(0, Math.min(1, b.remaining / max));
      const circ = 2 * Math.PI * 38;
      return `
        <div style="text-align:center">
          <div class="ring" style="width:86px;height:86px;margin:0 auto 8px">
            <svg width="86" height="86" viewBox="0 0 86 86" style="transform:rotate(-90deg)">
              <circle cx="43" cy="43" r="35" fill="none" stroke="#eef0f8" stroke-width="8"/>
              <circle cx="43" cy="43" r="35" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"/>
            </svg>
            <div class="val" style="font-size:17px">${b.remaining}<small style="font-size:8.5px">LEFT</small></div>
          </div>
          <div style="font-weight:700;font-size:12px">${label}</div>
          <div style="font-size:10.5px;color:var(--muted)">${b.used} used · ${b.total} total</div>
        </div>`;
    };
    el.innerHTML = `
      <div class="card-head"><div>
        <div class="card-title"><i data-lucide="plane-takeoff"></i> My Balances</div>
        <div class="card-sub">Year to date</div>
      </div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        ${ring('Annual', balances.annual, '#7c3aed', 20)}
        ${ring('Sick', balances.sick, '#0ea5e9', 12)}
        ${ring('Casual', balances.casual, '#14b8a6', 8)}
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty">Could not load balances</div>';
  }
}

async function loadLeaves() {
  const wrap = document.getElementById('leaves-wrap');
  if (!wrap) return;
  try {
    const params = new URLSearchParams({ scope: SCOPE });
    if (STATUS) params.set('status', STATUS);
    const { leaves } = await api('/leaves?' + params.toString());
    if (!leaves.length) {
      wrap.innerHTML = '<div class="empty"><i data-lucide="plane-takeoff"></i><b>No leave requests</b>' +
        (SCOPE === 'mine' ? 'Apply for your first leave!' : 'Nothing here yet.') + '</div>';
      refreshLucide(); return;
    }
    const canAct = (l) => CAN_REVIEW && l.status === 'pending' &&
      (SCOPE !== 'mine');
    wrap.innerHTML = `
      <table>
        <thead><tr>
          ${SCOPE !== 'mine' ? '<th>Employee</th>' : ''}
          <th>Type</th><th>Dates</th><th class="num">Days</th><th>Reason</th>
          <th>Status</th><th>Reviewer</th><th></th>
        </tr></thead>
        <tbody>
          ${leaves.map(l => `
            <tr>
              ${SCOPE !== 'mine' ? `<td>
                <div style="display:flex;align-items:center;gap:9px">
                  <div class="avatar sm" style="background:${avatarColor(l.employee_name || '?')}">${initialsOf(l.employee_name)}</div>
                  <div><div class="cell-main" style="font-size:13px">${esc(l.employee_name || '—')}</div>
                  <div class="cell-sub">${esc(l.emp_code || '')}</div></div>
                </div></td>` : ''}
              <td><span class="badge plain b-violet">${leaveTypeLabel(l.leave_type)}</span></td>
              <td><span style="font-size:12.5px;font-weight:600">${fmtDate(l.start_date)}<br/><span style="color:var(--muted);font-weight:500">→ ${fmtDate(l.end_date)}</span></span></td>
              <td class="num cell-main">${l.days}</td>
              <td style="max-width:220px"><span class="cell-sub" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.reason)}">${esc(l.reason)}</span></td>
              <td>${badge(l.status)}</td>
              <td class="cell-sub">${esc(l.reviewer_name || '—')}</td>
              <td><div class="row-actions">
                ${l.status === 'pending' && l.employee_id === USER.employee_id
                  ? `<button class="btn btn-danger btn-sm" data-cancel="${l.id}">Cancel</button>` : ''}
                ${canAct(l) ? `
                  <button class="btn btn-success btn-sm" data-approve="${l.id}"><i data-lucide="check"></i></button>
                  <button class="btn btn-danger btn-sm" data-reject="${l.id}"><i data-lucide="x"></i></button>` : ''}
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    refreshLucide();
    wrap.querySelectorAll('[data-approve]').forEach(b => b.onclick = () => review(b.dataset.approve, 'approved'));
    wrap.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => review(b.dataset.reject, 'rejected'));
    wrap.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => cancel(b.dataset.cancel));
  } catch {
    wrap.innerHTML = '<div class="empty">Could not load requests</div>';
  }
}

async function review(id, decision) {
  const ok = await confirmDialog({
    title: decision === 'approved' ? 'Approve this leave?' : 'Reject this request?',
    text: decision === 'approved'
      ? 'The employee\'s balance will be deducted atomically.'
      : 'The employee will be notified in their request list.',
    okText: decision === 'approved' ? 'Approve' : 'Reject',
    danger: decision !== 'approved',
  });
  if (!ok) return;
  try {
    const res = await api(`/leaves/${id}/${decision}`, { method: 'POST', body: {} });
    toast(res.message || `Leave ${decision}`, decision === 'approved' ? 'ok' : 'info');
    loadLeaves(); loadBalances(); loadPendingBadge();
  } catch { /* toast shown */ }
}

async function cancel(id) {
  const ok = await confirmDialog({ title: 'Cancel this request?', okText: 'Cancel request', danger: true });
  if (!ok) return;
  try {
    await api(`/leaves/${id}/cancel`, { method: 'POST', body: {} });
    toast('Request cancelled', 'info');
    loadLeaves();
  } catch { /* toast shown */ }
}

/* ---------- apply ---------- */
function openApply() {
  const f = document.getElementById('apply-form');
  f.reset();
  const today = new Date().toISOString().slice(0, 10);
  f.start_date.min = today;
  f.end_date.min = today;
  f.start_date.value = today;
  document.getElementById('apply-modal').classList.add('open');
  refreshLucide();
}
document.getElementById('apply-form')?.addEventListener('input', () => {
  const f = document.getElementById('apply-form');
  if (f.start_date.value && f.end_date.value && f.end_date.value >= f.start_date.value) {
    const days = Math.round((new Date(f.end_date.value) - new Date(f.start_date.value)) / 86400000) + 1;
    document.getElementById('days-preview').value = days + ' day' + (days > 1 ? 's' : '');
    f.end_date.min = f.start_date.value;
  }
});
document.getElementById('apply-save')?.addEventListener('click', async () => {
  const f = document.getElementById('apply-form');
  if (!f.reportValidity()) return;
  const btn = document.getElementById('apply-save');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Submitting…';
  refreshLucide();
  try {
    const res = await api('/leaves', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },   // replay-safe submissions
      body: {
        leave_type: f.leave_type.value,
        start_date: f.start_date.value,
        end_date: f.end_date.value,
        reason: f.reason.value.trim(),
      },
    });
    toast(res.message || 'Request submitted', 'ok');
    closeModal('apply-modal');
    SCOPE = 'mine';
    document.querySelectorAll('#scope-seg button').forEach(b =>
      b.classList.toggle('on', b.dataset.v === 'mine'));
    await Promise.all([loadLeaves(), loadBalances()]);
  } catch { /* toast shown */ }
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="send"></i> Submit request';
  refreshLucide();
});
