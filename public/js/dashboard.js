/* dashboard.js — role-aware command center with live charts */

const CHART_COLORS = {
  violet: '#7c3aed', fuchsia: '#d946ef', teal: '#14b8a6', amber: '#f59e0b',
  rose: '#f43f5e', sky: '#0ea5e9', slate: '#94a3b8',
};
let trendChart = null, deptChart = null, leaveChart = null, payChart = null;

(async function init() {
  const user = await requireAuth();
  buildShell('dashboard');
  const page = document.getElementById('page');
  page.innerHTML = skeletonRows(6);
  try {
    const d = await api('/dashboard');
    render(user, d);
  } catch { /* toast already shown */ }
})();

function render(user, d) {
  const page = document.getElementById('page');
  const isAdminHr = ['admin', 'hr'].includes(d.role);
  const isManager = d.role === 'manager';

  page.innerHTML = `
    <div class="grid kpis" style="margin-bottom:18px" id="kpi-row"></div>
    <div class="grid" style="grid-template-columns: 1.7fr 1fr; margin-bottom:18px" id="charts-row1"></div>
    <div class="grid" style="grid-template-columns: 1fr 1fr; margin-bottom:18px" id="charts-row2"></div>
    <div class="grid" style="grid-template-columns: 1fr 1fr;" id="bottom-row"></div>
  `;
  if (window.matchMedia('(max-width: 1100px)').matches) {
    page.querySelectorAll('.grid').forEach(g => { if (g.id !== 'kpi-row') g.style.gridTemplateColumns = '1fr'; });
  }

  renderKpis(d, isAdminHr, isManager);

  /* ---- row 1: attendance trend + dept distribution (admin/hr) ---- */
  const r1 = document.getElementById('charts-row1');
  if (isAdminHr) {
    r1.innerHTML = `
      <div class="card rise d1">
        <div class="card-head">
          <div><div class="card-title"><i data-lucide="trending-up"></i> Attendance Trend</div>
          <div class="card-sub">Daily presence pattern across the organisation</div></div>
          <div class="seg" id="trend-seg">
            <button data-days="7" class="on">7d</button><button data-days="30">30d</button>
          </div>
        </div>
        <div class="chart-wrap tall"><canvas id="trendChart"></canvas></div>
      </div>
      <div class="card rise d2">
        <div class="card-head">
          <div><div class="card-title"><i data-lucide="pie-chart"></i> Headcount by Department</div>
          <div class="card-sub">${d.headcount.active} active employees</div></div>
        </div>
        <div class="chart-wrap tall"><canvas id="deptChart"></canvas></div>
      </div>`;
    drawTrend(d.attendance_trend);
    drawDept(d.by_department);
    document.getElementById('trend-seg').onclick = async (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      document.querySelectorAll('#trend-seg button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      const fresh = await api('/dashboard');
      drawTrend(fresh.attendance_trend);
    };
  } else {
    r1.style.gridTemplateColumns = '1fr';
    r1.innerHTML = `
      <div class="card rise d1">
        <div class="card-head">
          <div><div class="card-title"><i data-lucide="calendar-check"></i> My Attendance — this month</div>
          <div class="card-sub">${d.my_month?.working_days ?? 0} working days logged</div></div>
        </div>
        <div class="chart-wrap"><canvas id="myMonthChart"></canvas></div>
      </div>
      ${isManager ? `<div class="card rise d2">
        <div class="card-head"><div><div class="card-title"><i data-lucide="users"></i> Team Today</div>
        <div class="card-sub">${d.team_size} direct reports</div></div></div>
        <div class="chart-wrap"><canvas id="teamTodayChart"></canvas></div></div>` : ''}
    `;
    drawMyMonth(d.my_month?.summary || {});
    if (isManager) drawTeamToday(d.team_today || {});
  }

  /* ---- row 2 ---- */
  const r2 = document.getElementById('charts-row2');
  const myBal = d.me?.leave_balances || {};
  const r2parts = [];
  if (isAdminHr) {
    r2parts.push(`
      <div class="card rise d1">
        <div class="card-head"><div><div class="card-title"><i data-lucide="plane-takeoff"></i> Leave Pipeline</div>
        <div class="card-sub">All requests by status</div></div></div>
        <div class="chart-wrap"><canvas id="leaveChart"></canvas></div>
      </div>`);
    r2parts.push(`
      <div class="card rise d2">
        <div class="card-head"><div><div class="card-title"><i data-lucide="wallet"></i> Payroll Cost — recent runs</div>
        <div class="card-sub">Net disbursement per cycle</div></div></div>
        <div class="chart-wrap"><canvas id="payChart"></canvas></div>
      </div>`);
  } else {
    r2parts.push(balanceCard(d.me, d.latest_payslip));
    r2parts.push(`
      <div class="card rise d2">
        <div class="card-head"><div><div class="card-title"><i data-lucide="zap"></i> Quick Actions</div>
        <div class="card-sub">Things you do often</div></div></div>
        <div class="quick-actions">
          <button class="qa-chip" onclick="location.href='attendance.html'"><i data-lucide="log-in"></i> Check in / out</button>
          <button class="qa-chip" onclick="location.href='leaves.html?apply=1'"><i data-lucide="plane-takeoff"></i> Apply for leave</button>
          <button class="qa-chip" onclick="location.href='payroll.html'"><i data-lucide="receipt"></i> View payslips</button>
          ${isManager ? `<button class="qa-chip" onclick="location.href='leaves.html?scope=team'"><i data-lucide="check-check"></i> Review team leaves</button>` : ''}
        </div>
        <div class="card-sub" style="margin-top:18px;margin-bottom:8px;font-weight:700;color:var(--ink-2)">My pending requests</div>
        <div id="my-pending-mini"></div>
      </div>`);
  }
  r2.innerHTML = r2parts.join('');
  if (isAdminHr) { drawLeaveMix(d.leave_mix || {}); drawPayroll(d.recent_runs || []); }
  else {
    renderMiniPending(d.my_pending_leaves || []);
  }

  /* ---- bottom row ---- */
  const br = document.getElementById('bottom-row');
  const parts = [];
  if (isAdminHr || isManager) {
    parts.push(`
      <div class="card rise d1">
        <div class="card-head">
          <div><div class="card-title"><i data-lucide="clock-4"></i> Pending Approvals</div>
          <div class="card-sub">${d.pending_count} request(s) waiting</div></div>
          <a href="leaves.html" style="font-size:12px;font-weight:700">View all →</a>
        </div>
        <div id="pending-list">${pendingListHtml(d.pending_approvals || [])}</div>
      </div>`);
  } else {
    parts.push(`
      <div class="card rise d1">
        <div class="card-head"><div><div class="card-title"><i data-lucide="clock-4"></i> My Pending Requests</div></div></div>
        <div id="pending-list">${pendingListHtml(d.my_pending_leaves || [])}</div>
      </div>`);
  }
  if (isAdminHr) {
    parts.push(`
      <div class="card rise d2">
        <div class="card-head">
          <div><div class="card-title"><i data-lucide="history"></i> Recent Activity</div>
          <div class="card-sub">Latest audit trail events</div></div>
          <a href="audit.html" style="font-size:12px;font-weight:700">Full log →</a>
        </div>
        <div class="timeline" id="activity-tl">
          ${(d.recent_audit || []).map(a => `
            <div class="tl-item">
              <div class="tl-title">${esc(a.actor_name || 'system')} · <span style="color:var(--violet)">${esc(a.action)}</span></div>
              <div class="tl-sub">${esc(a.entity_type || '')} · ${relTime(a.created_at)}</div>
            </div>`).join('') || '<div class="empty">No activity yet</div>'}
        </div>
      </div>`);
  } else {
    parts.push(holidayTile());
  }
  br.innerHTML = parts.join('');
  if (isAdminHr || isManager) wireApprovals();
  refreshLucide();
}

/* ================= KPI cards ================= */
function renderKpis(d, isAdminHr, isManager) {
  const row = document.getElementById('kpi-row');
  const cards = [];
  const today = d.today_attendance || d.team_today || {};
  const presentToday = (today.present || 0) + (today.late || 0) + (today.wfh || 0);

  if (isAdminHr) {
    cards.push(kpi('users', '#7c3aed', 'Total Employees', d.headcount.active,
      `<span class="kpi-trend trend-neutral">${d.headcount.inactive} inactive</span>`));
    cards.push(kpi('user-check', '#14b8a6', 'Present Today', presentToday,
      `<span class="kpi-trend ${presentToday > 0 ? 'trend-up' : 'trend-down'}">${(today.late || 0)} late · ${(today.wfh || 0)} WFH</span>`));
    cards.push(kpi('clock-4', '#f59e0b', 'Pending Approvals', d.pending_count,
      `<span class="kpi-trend trend-neutral">${d.leave_mix?.pending || 0} total pending</span>`));
    const last = (d.recent_runs || [])[0];
    cards.push(kpi('wallet', '#0ea5e9', 'Last Payroll Net', last?.net_total || 0,
      `<span class="kpi-trend trend-neutral">${last ? MONTH_NAMES[last.month - 1].slice(0, 3) + ' ' + last.year : '—'}</span>`, true));
  } else if (isManager) {
    cards.push(kpi('users', '#7c3aed', 'Team Size', d.team_size || 0, '<span class="kpi-trend trend-neutral">direct reports</span>'));
    cards.push(kpi('user-check', '#14b8a6', 'Team Present', presentToday, '<span class="kpi-trend trend-neutral">today</span>'));
    cards.push(kpi('clock-4', '#f59e0b', 'Pending Approvals', d.pending_count || 0, '<span class="kpi-trend trend-neutral">from your team</span>'));
    cards.push(kpi('plane-takeoff', '#0ea5e9', 'My Annual Balance', (d.me?.leave_balances?.annual ?? 0), '<span class="kpi-trend trend-neutral">days left</span>'));
  } else {
    const s = d.my_month?.summary || {};
    cards.push(kpi('plane-takeoff', '#7c3aed', 'Annual Balance', (d.me?.leave_balances?.annual ?? 0), '<span class="kpi-trend trend-neutral">days left</span>'));
    cards.push(kpi('user-check', '#14b8a6', 'Days Present', (s.present || 0) + (s.wfh || 0), '<span class="kpi-trend trend-neutral">this month</span>'));
    cards.push(kpi('clock-alert', '#f59e0b', 'Late Check-ins', s.late || 0, '<span class="kpi-trend trend-neutral">this month</span>'));
    const slip = d.latest_payslip;
    cards.push(kpi('wallet', '#0ea5e9', 'Latest Net Pay', slip?.net || 0,
      `<span class="kpi-trend trend-neutral">${slip ? MONTH_NAMES[slip.month - 1].slice(0, 3) + ' ' + slip.year : '—'}</span>`, true));
  }
  row.innerHTML = cards.join('');
  row.querySelectorAll('.kpi-val[data-count]').forEach(el => {
    const v = Number(el.dataset.count);
    if (el.dataset.money === '1') countUp(el, v, { money: true });
    else countUp(el, v);
  });
  refreshLucide();
}
function kpi(icon, color, label, value, trend, isMoney = false) {
  const isNum = typeof value === 'number';
  return `
    <div class="card kpi rise">
      <div class="kpi-ico" style="background:linear-gradient(135deg,${color},${color}cc)"><i data-lucide="${icon}"></i></div>
      <div class="kpi-meta">
        <div class="kpi-val" ${isNum ? `data-count="${value}" data-money="${isMoney ? 1 : 0}"` : ''}>${isNum ? '0' : value}</div>
        <div class="kpi-lbl">${label}</div>
        <div style="margin-top:4px">${trend}</div>
      </div>
    </div>`;
}

/* ================= charts ================= */
function baseOpts(extra = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { usePointStyle: true, boxWidth: 7, font: { size: 11, family: 'Plus Jakarta Sans' }, color: '#4a4e69' } } },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 10.5, family: 'Plus Jakarta Sans' }, color: '#8b90a7' } },
      y: { beginAtZero: true, grid: { color: '#eef0f8' }, ticks: { font: { size: 10.5 }, color: '#8b90a7', precision: 0 } },
      ...extra,
    },
  };
}
function drawTrend(rows) {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  const labels = rows.map(r => new Date(r.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Present', data: rows.map(r => r.present), borderColor: CHART_COLORS.teal, backgroundColor: 'rgba(20,184,166,.14)', fill: true, tension: .42, pointRadius: 2.5, borderWidth: 2.4 },
        { label: 'WFH', data: rows.map(r => r.wfh), borderColor: CHART_COLORS.sky, backgroundColor: 'rgba(14,165,233,.12)', fill: true, tension: .42, pointRadius: 2.5, borderWidth: 2 },
        { label: 'Late', data: rows.map(r => r.late), borderColor: CHART_COLORS.amber, backgroundColor: 'transparent', tension: .42, pointRadius: 2, borderWidth: 1.6, borderDash: [5, 3] },
        { label: 'Absent/Leave', data: rows.map(r => r.absent), borderColor: CHART_COLORS.rose, backgroundColor: 'rgba(244,63,94,.09)', tension: .42, pointRadius: 2, borderWidth: 1.6 },
      ],
    },
    options: baseOpts(),
  });
}
function drawDept(rows) {
  const ctx = document.getElementById('deptChart');
  if (!ctx) return;
  const palette = ['#7c3aed', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#f59e0b', '#14b8a6', '#0ea5e9', '#64748b'];
  if (deptChart) deptChart.destroy();
  deptChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => r.name),
      datasets: [{ data: rows.map(r => r.count), backgroundColor: palette, borderWidth: 3, borderColor: '#fff', hoverOffset: 8 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, font: { size: 10.5, family: 'Plus Jakarta Sans' }, color: '#4a4e69', padding: 12 } } },
    },
  });
}
function drawLeaveMix(mix) {
  const ctx = document.getElementById('leaveChart');
  if (!ctx) return;
  const order = ['approved', 'pending', 'rejected', 'cancelled'];
  const colors = { approved: '#14b8a6', pending: '#f59e0b', rejected: '#f43f5e', cancelled: '#94a3b8' };
  if (leaveChart) leaveChart.destroy();
  leaveChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: order.map(o => o[0].toUpperCase() + o.slice(1)),
      datasets: [{ data: order.map(o => mix[o] || 0), backgroundColor: order.map(o => colors[o]), borderWidth: 3, borderColor: '#fff', hoverOffset: 8 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, font: { size: 10.5, family: 'Plus Jakarta Sans' }, color: '#4a4e69', padding: 12 } } },
    },
  });
}
function drawPayroll(runs) {
  const ctx = document.getElementById('payChart');
  if (!ctx) return;
  const sorted = [...runs].reverse();
  if (payChart) payChart.destroy();
  payChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: sorted.map(r => MONTH_NAMES[r.month - 1].slice(0, 3) + ' ' + String(r.year).slice(2)),
      datasets: [
        { label: 'Gross', data: sorted.map(r => r.gross_total), backgroundColor: 'rgba(124,58,237,.35)', borderRadius: 8, borderSkipped: false },
        { label: 'Net paid', data: sorted.map(r => r.net_total), backgroundColor: '#7c3aed', borderRadius: 8, borderSkipped: false },
      ],
    },
    options: baseOpts({
      y: { beginAtZero: true, grid: { color: '#eef0f8' }, ticks: { font: { size: 10 }, color: '#8b90a7', callback: (v) => '₹' + (v / 100000).toFixed(1) + 'L' } },
    }),
  });
}
function drawMyMonth(summary) {
  const ctx = document.getElementById('myMonthChart');
  if (!ctx) return;
  const labels = ['Present', 'WFH', 'Late', 'Absent', 'On Leave'];
  const data = [summary.present || 0, summary.wfh || 0, summary.late || 0, summary.absent || 0, summary.leave || 0];
  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: ['#14b8a6', '#0ea5e9', '#f59e0b', '#f43f5e', '#7c3aed'], borderRadius: 9, borderSkipped: false, barThickness: 34 }] },
    options: { ...baseOpts(), plugins: { legend: { display: false } } },
  });
}
function drawTeamToday(summary) {
  const ctx = document.getElementById('teamTodayChart');
  if (!ctx) return;
  const labels = ['Present', 'WFH', 'Late', 'Absent'];
  const data = [summary.present || 0, summary.wfh || 0, summary.late || 0, (summary.absent || 0) + (summary.leave || 0)];
  new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: ['#14b8a6', '#0ea5e9', '#f59e0b', '#f43f5e'], borderRadius: 9, borderSkipped: false, barThickness: 34 }] },
    options: { ...baseOpts(), plugins: { legend: { display: false } } },
  });
}

/* ================= shared pieces ================= */
function balanceCard(me, slip) {
  const bal = me?.leave_balances || { annual: 0, sick: 0, casual: 0 };
  const total = 20;
  const ring = (label, val, max, color) => {
    const pct = Math.max(0, Math.min(1, val / max));
    const circ = 2 * Math.PI * 38;
    return `
      <div class="bal-card">
        <div class="ring">
          <svg width="92" height="92" viewBox="0 0 92 92">
            <circle cx="46" cy="46" r="38" fill="none" stroke="#eef0f8" stroke-width="9"/>
            <circle cx="46" cy="46" r="38" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
              stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"/>
          </svg>
          <div class="val">${val}<small>DAYS</small></div>
        </div>
        <div style="font-weight:700;font-size:12.5px">${label}</div>
        <div style="font-size:11px;color:var(--muted)">of ${max} days</div>
      </div>`;
  };
  return `
    <div class="card rise d1">
      <div class="card-head"><div><div class="card-title"><i data-lucide="plane-takeoff"></i> My Leave Balances</div>
      <div class="card-sub">${me?.emp_code || ''} · ${esc(me?.designation || '')}</div></div></div>
      <div class="bal-grid">
        ${ring('Annual', bal.annual ?? 0, total, '#7c3aed')}
        ${ring('Sick', bal.sick ?? 0, 12, '#0ea5e9')}
        ${ring('Casual', bal.casual ?? 0, 8, '#14b8a6')}
      </div>
      ${slip ? `<div class="mini-stat" style="margin-top:10px">
        <div class="dot-ico" style="background:rgba(124,58,237,.1);color:var(--violet)"><i data-lucide="receipt"></i></div>
        <div><b>${money(slip.net)}</b><span>Latest payslip · ${MONTH_NAMES[slip.month - 1]} ${slip.year}</span></div>
        <a class="btn btn-ghost btn-sm" style="margin-left:auto" href="payroll.html">View</a>
      </div>` : ''}
    </div>`;
}
function pendingListHtml(items) {
  if (!items.length) {
    return `<div class="empty"><i data-lucide="check-circle-2"></i><b>All caught up!</b>No requests waiting for review.</div>`;
  }
  return items.map(l => `
    <div class="approve-card" data-id="${l.id}">
      <div class="avatar" style="background:${avatarColor(l.employee_name || '?')}">${initialsOf(l.employee_name)}</div>
      <div class="meta">
        <b>${esc(l.employee_name || 'Employee')}</b>
        <span>${leaveTypeLabel(l.leave_type)} · ${l.days} day${l.days > 1 ? 's' : ''} · ${fmtDate(l.start_date)} → ${fmtDate(l.end_date)}</span>
      </div>
      <button class="btn btn-success btn-sm act-approve"><i data-lucide="check"></i></button>
      <button class="btn btn-danger btn-sm act-reject"><i data-lucide="x"></i></button>
    </div>`).join('');
}
function wireApprovals() {
  document.querySelectorAll('.approve-card').forEach(card => {
    const id = card.dataset.id;
    card.querySelector('.act-approve').onclick = async () => {
      try { await api(`/leaves/${id}/approve`, { method: 'POST', body: {} }); toast('Leave approved', 'ok'); card.remove(); loadPendingBadge(); }
      catch { /* toast shown */ }
    };
    card.querySelector('.act-reject').onclick = async () => {
      try { await api(`/leaves/${id}/reject`, { method: 'POST', body: {} }); toast('Leave rejected', 'info'); card.remove(); loadPendingBadge(); }
      catch { /* toast shown */ }
    };
  });
}
function renderMiniPending(items) {
  const el = document.getElementById('my-pending-mini');
  if (!el) return;
  el.innerHTML = items.length ? items.map(l => `
    <div class="mini-stat">
      <div class="dot-ico" style="background:rgba(245,158,11,.13);color:#b45309"><i data-lucide="clock-4"></i></div>
      <div><b>${leaveTypeLabel(l.leave_type)} · ${l.days}d</b><span>${fmtDate(l.start_date)} → ${fmtDate(l.end_date)}</span></div>
      ${badge('pending')}
    </div>`).join('')
    : '<div class="empty" style="padding:18px"><i data-lucide="check-circle-2"></i><b>Nothing pending</b></div>';
  refreshLucide();
}
function holidayTile() {
  return `
    <div class="card rise d2">
      <div class="card-head"><div><div class="card-title"><i data-lucide="sparkles"></i> Did you know?</div></div></div>
      <div style="color:var(--ink-2);font-size:13.5px;line-height:1.8">
        Your attendance and payroll records update in real time. Apply for leave at least a day ahead —
        your manager reviews it instantly, and balances adjust automatically once approved.
      </div>
      <div class="quick-actions" style="margin-top:16px">
        <button class="qa-chip" onclick="location.href='leaves.html?apply=1'"><i data-lucide="plane-takeoff"></i> Apply for leave</button>
        <button class="qa-chip" onclick="location.href='payroll.html'"><i data-lucide="receipt"></i> My payslips</button>
      </div>
    </div>`;
}
