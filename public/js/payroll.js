/* payroll.js — runs management (admin/hr) + personal payslips */
let USER = null;

(async function init() {
  USER = await requireAuth();
  buildShell('payroll');
  wireModals();
  const isAdminHr = ['admin', 'hr'].includes(USER.role);
  if (isAdminHr) renderRunsView();
  else renderPersonalView();
})();

/* =============== admin / hr view =============== */
function renderRunsView() {
  document.getElementById('page').innerHTML = `
    <div class="card table-card rise">
      <div class="table-toolbar">
        <div>
          <div class="card-title"><i data-lucide="wallet"></i> Payroll Runs</div>
          <div class="card-sub">One locked run per (month, year) — enforced by a unique index</div>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="new-run"><i data-lucide="play"></i> Run Payroll</button>
      </div>
      <div class="table-scroll"><div id="runs-wrap">${skeletonRows(4)}</div></div>
    </div>`;
  document.getElementById('new-run').onclick = () => openRunModal();
  document.getElementById('run-go').onclick = executeRun;
  loadRuns();
  refreshLucide();
}

async function loadRuns() {
  const wrap = document.getElementById('runs-wrap');
  if (!wrap) return;
  try {
    const { runs } = await api('/payroll/runs');
    if (!runs.length) {
      wrap.innerHTML = '<div class="empty"><i data-lucide="wallet"></i><b>No payroll runs yet</b>Execute your first run above.</div>';
      refreshLucide(); return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Period</th><th class="num">Employees</th>
          <th class="num">Gross</th><th class="num">Net disbursed</th>
          <th>Status</th><th>Executed by</th><th>Date</th><th></th></tr></thead>
        <tbody>
          ${runs.map(r => `
            <tr>
              <td><b>${MONTH_NAMES[r.month - 1]} ${r.year}</b></td>
              <td class="num">${r.total_employees}</td>
              <td class="num cell-main">${money(r.gross_total)}</td>
              <td class="num" style="color:var(--violet);font-weight:800">${money(r.net_total)}</td>
              <td>${badge(r.status)}</td>
              <td>${esc(r.created_by_name || '—')}</td>
              <td class="cell-sub">${fmtDate(r.completed_at || r.created_at)}</td>
              <td><div class="row-actions">
                <button class="btn btn-ghost btn-sm" data-open="${r.id}"><i data-lucide="eye"></i> Payslips</button>
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    refreshLucide();
    wrap.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openRun(b.dataset.open));
  } catch {
    wrap.innerHTML = '<div class="empty">Could not load runs</div>';
  }
}

function openRunModal() {
  const now = new Date();
  const nm = now.getMonth() + 1;
  document.getElementById('run-month').value = nm === 12 ? 1 : nm + 1;
  document.getElementById('run-year').value = nm === 12 ? now.getFullYear() + 1 : now.getFullYear();
  document.getElementById('run-modal').classList.add('open');
}

async function executeRun() {
  const month = Number(document.getElementById('run-month').value);
  const year = Number(document.getElementById('run-year').value);
  const btn = document.getElementById('run-go');
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Processing…';
  refreshLucide();
  try {
    const res = await api('/payroll/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { month, year },
    });
    toast(res.message || 'Payroll completed', 'ok');
    closeModal('run-modal');
    loadRuns();
  } catch { /* toast shown */ }
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="play"></i> Execute run';
  refreshLucide();
}

async function openRun(runId) {
  try {
    const { run, payslips } = await api(`/payroll/runs/${runId}`);
    document.getElementById('page').innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="back-runs"><i data-lucide="arrow-left"></i> All runs</button>
        <div><div style="font-size:15.5px;font-weight:800">${MONTH_NAMES[run.month - 1]} ${run.year} — Payslips</div>
        <div class="card-sub">${run.total_employees} employees · net ${money(run.net_total)}</div></div>
      </div>
      <div class="card table-card">
        <div class="table-scroll"><table>
          <thead><tr><th>Employee</th><th class="num">Base</th><th class="num">Allowances</th>
            <th class="num">Deductions</th><th class="num">Net Pay</th><th class="num">Days present</th><th></th></tr></thead>
          <tbody>
            ${payslips.map(s => `
              <tr>
                <td><div style="display:flex;align-items:center;gap:9px">
                  <div class="avatar sm" style="background:${avatarColor(s.name || '?')}">${initialsOf(s.name)}</div>
                  <div><div class="cell-main" style="font-size:13px">${esc(s.name)}</div>
                  <div class="cell-sub">${esc(s.designation || '')} · ${esc(s.department || '')}</div></div></div></td>
                <td class="num">${money(s.base_salary)}</td>
                <td class="num" style="color:#059669;font-weight:600">+${money(s.hra + s.conveyance + s.special)}</td>
                <td class="num" style="color:#e11d48;font-weight:600">−${money(s.deductions)}</td>
                <td class="num cell-main" style="color:var(--violet)">${money(s.net)}</td>
                <td class="num">${s.days_present}</td>
                <td><button class="btn btn-ghost btn-sm" data-slip="${s.id}"><i data-lucide="receipt"></i> Slip</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    document.getElementById('back-runs').onclick = renderRunsView;
    refreshLucide();
    document.querySelectorAll('[data-slip]').forEach(b => b.onclick = () => showSlip(b.dataset.slip, payslips));
  } catch { /* toast shown */ }
}

function showSlip(slipId, payslips) {
  const s = payslips.find(p => p.id === slipId);
  if (!s) return;
  document.getElementById('slip-body').innerHTML = payslipHtml(s);
  document.getElementById('slip-modal').classList.add('open');
}

function payslipHtml(s) {
  return `
    <div class="payslip">
      <div class="payslip-head">
        <div class="co">Zentra Technologies<small>Employee salary statement</small></div>
        <div class="period"><b>${MONTH_NAMES[s.month - 1]} ${s.year}</b>Generated ${fmtDate(s.created_at)}</div>
      </div>
      <div style="padding:14px 24px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div><div class="card-sub">Employee</div><b>${esc(s.name)}</b> <span class="cell-mono">${esc(s.emp_code || '')}</span></div>
        <div style="text-align:right"><div class="card-sub">Designation</div><b>${esc(s.designation || '—')}</b></div>
      </div>
      <div class="ps-grid">
        <div class="ps-rows">
          <div class="ps-row"><span>Base salary</span><b>${money(s.base_salary)}</b></div>
          <div class="ps-row"><span>House rent allowance (20%)</span><b>+${money(s.hra)}</b></div>
          <div class="ps-row"><span>Conveyance allowance</span><b>+${money(s.conveyance)}</b></div>
          <div class="ps-row"><span>Special allowance</span><b>+${money(s.special)}</b></div>
          <div class="ps-row" style="font-weight:800"><span>Gross earnings</span><b>${money(s.gross)}</b></div>
          <div class="ps-row"><span>Provident fund (12%)</span><b style="color:#e11d48">−${money(s.pf)}</b></div>
          <div class="ps-row"><span>Income tax (10%)</span><b style="color:#e11d48">−${money(s.tax)}</b></div>
          <div class="ps-row"><span>Professional tax</span><b style="color:#e11d48">−${money(s.prof_tax)}</b></div>
          <div class="ps-row total"><span>NET PAY</span><b>${money(s.net)}</b></div>
        </div>
        <div style="padding:16px 20px;border-left:1px dashed var(--line);min-width:130px">
          <div class="card-sub">Days present</div><b style="font-size:22px">${s.days_present}</b>
          <div class="card-sub" style="margin-top:12px">Period</div>
          <b style="font-size:14px">${MONTH_NAMES[s.month - 1].slice(0, 3)} ${s.year}</b>
        </div>
      </div>
    </div>`;
}

/* =============== employee / manager view =============== */
async function renderPersonalView() {
  document.getElementById('page').innerHTML = `
    <div class="card table-card rise">
      <div class="table-toolbar">
        <div>
          <div class="card-title"><i data-lucide="receipt"></i> My Payslips</div>
          <div class="card-sub">Generated automatically each payroll cycle</div>
        </div>
      </div>
      <div class="table-scroll"><div id="slips-wrap">${skeletonRows(4)}</div></div>
    </div>`;
  try {
    const { payslips } = await api('/payroll/payslips/mine');
    const wrap = document.getElementById('slips-wrap');
    if (!payslips.length) {
      wrap.innerHTML = '<div class="empty"><i data-lucide="receipt"></i><b>No payslips yet</b>They appear here after your first payroll run.</div>';
      refreshLucide(); return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Period</th><th class="num">Gross</th><th class="num">Deductions</th>
          <th class="num">Net Pay</th><th class="num">Days present</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${payslips.map(s => `
            <tr>
              <td><b>${MONTH_NAMES[s.month - 1]} ${s.year}</b></td>
              <td class="num">${money(s.gross)}</td>
              <td class="num" style="color:#e11d48">−${money(s.deductions)}</td>
              <td class="num cell-main" style="color:var(--violet);font-size:14px">${money(s.net)}</td>
              <td class="num">${s.days_present}</td>
              <td>${badge(s.run_status || 'completed')}</td>
              <td><button class="btn btn-ghost btn-sm" data-view-slip="${s.id}"><i data-lucide="eye"></i> View</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    refreshLucide();
    document.querySelectorAll('[data-view-slip]').forEach(b =>
      b.onclick = () => {
        const s = payslips.find(p => p.id === b.dataset.viewSlip);
        document.getElementById('slip-body').innerHTML = payslipHtml(s);
        document.getElementById('slip-modal').classList.add('open');
      });
  } catch { /* toast shown */ }
}
