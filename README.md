# Zentra HR — Employee Management Portal

A production-grade, full-stack employee management portal built with
**Flask + MongoDB + JWT + bcrypt**, deployable to **Vercel** in minutes.

| Capability | Detail |
|---|---|
| **Employee records** | Onboarding (employee + login account created atomically), profiles, soft delete, salary & leave setup |
| **Department hierarchies** | Self-referencing parent/child tree, department heads, live headcounts |
| **Attendance tracking** | Check-in / check-out, late detection (IST work rules), monthly logs, unique constraint per employee-day |
| **Leave workflows** | Apply → approve/reject with atomic balance deduction, cancel, per-type balances (annual / sick / casual) |
| **Payroll management** | Salary runs with transparent breakdown (HRA / conveyance / special, PF / tax / professional tax), printable payslips |
| **Security** | JWT (HS256, expiring), bcrypt password hashing, role-based access control — **Admin / HR / Manager / Employee** |
| **Concurrency safety** | ACID multi-document transactions, optimistic locking (version fields), idempotency keys, unique indexes — no double approvals, no duplicate payroll runs, no lost updates |
| **Audit trail** | Every sensitive action recorded: who, what, when, IP — browsable and filterable |
| **Dashboards** | Headcount, attendance trends (7/30d), department distribution, leave pipeline, payroll cost, pending approvals — role-aware |

---

## 1. Architecture

```
├── api/                      # Flask backend (Vercel serverless function)
│   ├── index.py              # App entry — registers blueprints, serves static files
│   ├── core.py               # MongoDB layer, indexes, JWT/bcrypt, RBAC decorators,
│   │                         #   transaction runner, idempotency engine, audit writer
│   ├── routes_auth.py        # /api/auth/*           login, me, change-password
│   ├── routes_people.py      # /api/employees/*     CRUD + onboarding (transactional)
│   │                         # /api/departments/*   hierarchy CRUD
│   ├── routes_time.py        # /api/attendance/*    check-in/out, logs
│   │                         # /api/leaves/*        apply (idempotent), approve (atomic)
│   ├── routes_pay.py         # /api/payroll/*       locked runs + payslips
│   ├── routes_misc.py        # /api/dashboard       role-aware analytics
│   │                         # /api/audit           audit browsing, /api/health
│   └── seed.py               # Stage-guarded demo dataset (runs automatically)
├── public/                   # Frontend (served by Vercel edge / Flask locally)
│   ├── login.html            # Split-screen auth with demo account chips
│   ├── index.html            # Dashboard (Chart.js analytics)
│   ├── employees.html  departments.html  attendance.html
│   ├── leaves.html     payroll.html        audit.html
│   ├── css/styles.css        # Full design system (no CSS framework needed)
│   └── js/                   # app.js (shell/api client) + one controller per page
├── requirements.txt
└── vercel.json               # Routes /api/* → Flask function
```

**How concurrency safety works (the interesting part):**

| Guarantee | Mechanism |
|---|---|
| Double check-in impossible | Unique compound index `(employee_id, date)` → loser gets HTTP 409 |
| Never two approvers | Optimistic locking: reviewer update matches `{status: "pending", version: N}` — one winner, others get 409 |
| Balance never overdraws | The check `leave_balances.<type> >= days` lives **inside** the atomic update predicate |
| All-or-nothing approval | Status flip + balance deduction + audit entry run in one ACID transaction (with WriteConflict retry) |
| Duplicate payroll impossible | Unique index on `(year, month)` — even two racing admins collide at the DB level |
| Safe retries / double clicks | `Idempotency-Key` header → first response is cached and replayed; never executed twice |

MongoDB Atlas replica sets support multi-document transactions — the app probes
support at runtime and degrades to guarded sequential writes where unavailable,
so correctness never depends on the transaction.

---

## 2. Run locally

```bash
# 1) Python 3.9+ and a MongoDB instance (local mongod or Atlas)
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2) Configure
cp .env.example .env
#   → set MONGODB_URI (mongodb://127.0.0.1:27017 works with a local mongod)
#   → set JWT_SECRET to any long random string

# 3) Run
python api/index.py            # serves API + frontend on http://localhost:3000
```

Open **http://localhost:3000** — the demo dataset seeds itself on first visit
(20 employees, 9 departments, 6 weeks of attendance, leave history, 2 payroll runs).

### Demo accounts (password: `Password@123`)

| Role | Email |
|---|---|
| Admin | `vikram.rao@zentra.dev` |
| HR | `priya.sharma@zentra.dev` |
| Manager | `arjun.nair@zentra.dev` |
| Employee | `neha.kulkarni@zentra.dev` |

---

## 3. Deploy to Vercel (step by step)

### Step A — Create a free MongoDB Atlas database
1. Go to **cloud.mongodb.com** → sign up → build a **free M0 cluster**.
2. **Database Access** → add user (username + password, keep them handy).
3. **Network Access** → add IP `0.0.0.0/0` (allow from anywhere — required for serverless).
4. **Connect → Drivers → Python** → copy the connection string, e.g.
   `mongodb+srv://myuser:mypass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
   → append the db name before the `?`: `…mongodb.net/emp_portal?retryWrites=true&w=majority`

### Step B — Push the project to GitHub
```bash
cd employee-portal
git init && git add . && git commit -m "Employee Management Portal"
# create a repo on github.com, then:
git remote add origin https://github.com/<you>/employee-portal.git
git push -u origin main
```

### Step C — Import into Vercel
1. **vercel.com** → sign in with GitHub → **Add New → Project** → import the repo.
2. Framework preset: **Other** (auto-detected is fine — the `api/` + `public/` layout is Vercel-native).
3. **Environment Variables** → add:
   | Name | Value |
   |---|---|
   | `MONGODB_URI` | your Atlas URI from Step A |
   | `JWT_SECRET` | a long random string (`python -c "import secrets; print(secrets.token_hex(32))"`) |
4. Click **Deploy** — done. Your portal is live at `https://<project>.vercel.app`.
5. Visit the site → log in with a demo account → data seeds automatically on first load.

> CLI alternative: `npm i -g vercel && vercel --prod` and set the env vars when prompted.

### Step D — First login
Use the admin account, change passwords under **your accounts** if you like,
and start onboarding real people from **Employees → Onboard Employee**.

---

## 4. API reference (all JSON, bearer-token protected)

| Method | Endpoint | Roles | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | public | bcrypt verify → JWT, brute-force throttled |
| GET | `/api/auth/me` | any | session profile |
| POST | `/api/auth/change-password` | any | |
| GET | `/api/employees` | any | role-scoped fields (salary hidden from non-admin/hr) |
| POST | `/api/employees` | admin, hr | transactional onboarding |
| PUT / DELETE | `/api/employees/<id>` | admin, hr / admin | soft delete |
| GET | `/api/departments` | any | includes head + live member counts |
| POST / PUT / DELETE | `/api/departments/*` | admin, hr / admin, hr / admin | unique code, hierarchy guarded |
| POST | `/api/attendance/check-in` | any | 409 on same-day duplicate |
| POST | `/api/attendance/check-out` | any | compare-and-set — one winner |
| GET | `/api/attendance` | any | scoped: employee→self, manager→team |
| POST | `/api/leaves` | any | **idempotent** via `Idempotency-Key` header |
| GET | `/api/leaves?scope=mine\|team\|all` | any / manager+ / admin,hr | |
| POST | `/api/leaves/<id>/approve` `…/reject` | admin, hr, manager* | *managers: direct reports only — atomic + audited |
| POST | `/api/leaves/<id>/cancel` | owner | pending only |
| GET | `/api/leaves/balances/me` · `/api/leaves/pending/count` | any | |
| POST | `/api/payroll/runs` | admin, hr | **idempotent**, unique (year, month), atomic |
| GET | `/api/payroll/runs` · `/api/payroll/runs/<id>` | admin, hr | second includes payslips |
| GET | `/api/payroll/payslips/mine` · `/api/payroll/payslips/<id>` | any | ownership enforced |
| GET | `/api/dashboard` | any | role-aware tiles |
| GET | `/api/audit` | admin, hr | filter by action / actor |
| GET | `/api/health` | public | DB ping + auto-seed hook |

---

## 5. Notes & customization

- **Business timezone** — attendance dates, late thresholds (09:30) and payroll
  periods are computed in IST (`core.IST`). Adjust `WORK_START` / `IST` in `api/core.py`.
- **Salary formula** — see `_payslip_for` in `api/routes_pay.py` (HRA 20%, conveyance ₹800,
  special 10%, PF 12%, tax 10%, professional tax ₹200).
- **Seeding** — controlled by `AUTO_SEED=true`; each block is stage-guarded so a
  restart mid-seed resumes safely. Delete the `app_meta` collection + data to re-seed.
- **Roles** — `admin > hr > manager > employee`; gates live in `roles_required(...)`
  decorators and are re-checked per resource (e.g. managers only review their reports).
