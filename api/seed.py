"""
seed.py — Idempotent demo-data seeding.

Deployments start with a rich, realistic dataset (people, hierarchy, 6 weeks of
attendance, leave history, two completed payroll cycles) so the dashboards are
alive from the very first login. Every block is independently stage-guarded, so
a cold-start race or a mid-seed crash simply resumes where it stopped — no
duplicates, no orphaned state.
"""
import random
from datetime import timedelta

from core import (DEFAULT_BALANCES, APP_NAME, AUTO_SEED, audit, hash_password, now_utc,
                  attendance as att_col, departments as dep_col, employees as emp_col,
                  leave_requests as lv_col, payroll_runs as run_col, payslips as slip_col,
                  users as user_col, app_meta as meta_col, serialize)
from routes_pay import _payslip_for

random.seed(42)

DEPARTMENTS = [
    ("Executive Leadership", "EXEC", None),
    ("Engineering", "ENG", "Executive Leadership"),
    ("Platform Engineering", "ENG-BE", "Engineering"),
    ("Frontend Experience", "ENG-FE", "Engineering"),
    ("Quality Assurance", "ENG-QA", "Engineering"),
    ("People & Culture", "HR", "Executive Leadership"),
    ("Finance", "FIN", "Executive Leadership"),
    ("Marketing", "MKT", "Executive Leadership"),
    ("Sales", "SLS", "Executive Leadership"),
]

# name, dept_code, designation, manager_key, salary(₹/mo), role, join_date
PEOPLE = [
    ("Vikram Rao",     "EXEC",   "Chief Executive Officer",  None,      250000, "admin",    "2021-04-01"),
    ("Priya Sharma",   "HR",     "HR Manager",               "Vikram",  110000, "hr",       "2021-06-15"),
    ("Arjun Nair",     "ENG-BE", "Engineering Manager",      "Vikram",  160000, "manager",  "2021-07-01"),
    ("Neha Kulkarni",  "ENG-BE", "Senior Backend Developer", "Arjun",   95000,  "employee", "2022-01-10"),
    ("Ananya Desai",   "ENG-BE", "Backend Developer",        "Arjun",   78000,  "employee", "2022-08-22"),
    ("Karan Malhotra", "ENG-BE", "DevOps Engineer",          "Arjun",   88000,  "employee", "2023-03-13"),
    ("Rohan Gupta",    "ENG-FE", "Frontend Lead",            "Vikram",  140000, "manager",  "2021-09-05"),
    ("Meera Pillai",   "ENG-FE", "Frontend Developer",       "Rohan",   72000,  "employee", "2023-01-09"),
    ("Aditya Verma",   "ENG-FE", "UI Engineer",              "Rohan",   65000,  "employee", "2023-11-20"),
    ("Sara Thomas",    "ENG-QA", "QA Lead",                  "Vikram",  120000, "manager",  "2022-02-01"),
    ("Riya Chatterjee","ENG-QA", "QA Engineer",              "Sara",    58000,  "employee", "2023-06-12"),
    ("Nikhil Bansal",  "ENG-QA", "Automation Engineer",      "Sara",    68000,  "employee", "2024-02-19"),
    ("Sameer Joshi",   "FIN",    "Finance Controller",       "Vikram",  130000, "manager",  "2021-05-10"),
    ("Lakshmi Menon",  "FIN",    "Financial Analyst",        "Sameer",  62000,  "employee", "2023-04-03"),
    ("Farhan Khan",    "MKT",    "Marketing Lead",           "Vikram",  125000, "manager",  "2022-05-16"),
    ("Isha Kapoor",    "MKT",    "Content Strategist",       "Farhan",  55000,  "employee", "2023-09-11"),
    ("Dev Patel",      "SLS",    "Sales Manager",            "Vikram",  135000, "manager",  "2022-03-07"),
    ("Tanvi Reddy",    "SLS",    "Account Executive",        "Dev",     60000,  "employee", "2023-07-24"),
    ("Pooja Singh",    "HR",     "HR Generalist",            "Priya",   52000,  "employee", "2024-01-15"),
    ("Aisha Bhat",     "EXEC",   "Executive Assistant",      "Vikram",  48000,  "employee", "2022-10-03"),
]

LEAVE_SEED = [
    ("Neha Kulkarni",   "annual", -18, 3, "approved"),
    ("Ananya Desai",    "sick",   -12, 2, "approved"),
    ("Meera Pillai",    "casual", -9,  1, "approved"),
    ("Karan Malhotra",  "annual", -6,  4, "approved"),
    ("Riya Chatterjee", "sick",   -4,  1, "approved"),
    ("Dev Patel",       "annual", 4,   3, "pending"),
    ("Neha Kulkarni",   "casual", 7,   2, "pending"),
    ("Isha Kapoor",     "annual", 10,  5, "pending"),
    ("Aditya Verma",    "sick",   2,   1, "pending"),
    ("Tanvi Reddy",     "casual", 14,  2, "pending"),
    ("Lakshmi Menon",   "annual", 21,  4, "pending"),
    ("Nikhil Bansal",   "annual", -3,  2, "rejected"),
    ("Pooja Singh",     "casual", -2,  1, "rejected"),
    ("Aisha Bhat",      "annual", 5,   2, "pending"),
]

REASONS = {
    "annual": ["Family function out of town", "Planned vacation with family",
               "Personal errands and travel", "Annual trip — already booked"],
    "sick": ["Fever and cold, doctor advised rest", "Food poisoning — recovering",
             "Migraine, will catch up on pending work"],
    "casual": ["Apartment maintenance visit", "Bank documentation work",
               "Relative's engagement ceremony"],
}


def ensure_seeded():
    """Called on /api/health and /api/auth/login. Cheap once seeded."""
    if not AUTO_SEED:
        return
    try:
        if meta_col.find_one({"key": "seed_state"}):
            return
        meta_col.insert_one({"key": "seed_state", "created_at": now_utc()})
        _seed()
    except Exception as exc:
        import sys
        print(f"[seed] error: {exc}", file=sys.stderr)
        meta_col.delete_one({"key": "seed_state"})   # allow retry on next boot


# --------------------------------------------------------------------------- #
# Stage 1 — departments
# --------------------------------------------------------------------------- #
def _seed_departments() -> dict:
    dept_ids = {}
    for d in dep_col.find({}, {"code": 1, "_id": 1}):
        dept_ids[d["code"]] = d["_id"]
    for name, code, parent in DEPARTMENTS:
        if code in dept_ids:
            continue
        res = dep_col.insert_one({
            "name": name, "code": code,
            "parent_id": dept_ids.get(parent), "head_id": None,
            "description": f"{name} department of {APP_NAME} Technologies",
            "created_at": now_utc()})
        dept_ids[code] = res.inserted_id
    return dept_ids


# --------------------------------------------------------------------------- #
# Stage 2 — employees, managers, dept heads
# --------------------------------------------------------------------------- #
def _seed_employees(dept_ids: dict) -> dict:
    emp_ids = {f"{e['first_name']} {e['last_name']}": e["_id"]
               for e in emp_col.find({}, {"first_name": 1, "last_name": 1, "_id": 1})}
    if emp_col.count_documents({}) > 0:
        return emp_ids

    for i, (full, dept_code, designation, mgr_key, salary, role, join) in enumerate(PEOPLE):
        first, last = full.split(" ", 1)
        email = f"{first.lower()}.{last.lower().replace(' ', '')}@zentra.dev"
        doc = {
            "emp_code": f"ZT-{1001 + i}", "first_name": first, "last_name": last,
            "email": email, "phone": f"+91 9{random.randint(100000000, 999999999)}",
            "department_id": dept_ids.get(dept_code), "manager_id": None,
            "designation": designation, "employment_type": "full_time",
            "join_date": join, "status": "active", "salary": salary,
            "leave_balances": DEFAULT_BALANCES.copy(),
            "created_at": now_utc(), "updated_at": now_utc(),
        }
        res = emp_col.insert_one(doc)
        emp_ids[full] = res.inserted_id

    for full, dept_code, designation, mgr_key, salary, role, join in PEOPLE:
        if not mgr_key:
            continue
        # manager keys in PEOPLE are first names — resolve to the full-name id
        mgr_full = next((name for name in emp_ids if name.split(" ")[0] == mgr_key), None)
        if mgr_full:
            emp_col.update_one({"_id": emp_ids[full]},
                               {"$set": {"manager_id": emp_ids[mgr_full]}})

    heads = {"ENG": "Arjun Nair", "HR": "Priya Sharma", "FIN": "Sameer Joshi",
             "MKT": "Farhan Khan", "SLS": "Dev Patel", "EXEC": "Vikram Rao",
             "ENG-BE": "Arjun Nair", "ENG-FE": "Rohan Gupta", "ENG-QA": "Sara Thomas"}
    for code, head in heads.items():
        if head in emp_ids:
            dep_col.update_one({"code": code}, {"$set": {"head_id": emp_ids[head]}})
    return emp_ids


# --------------------------------------------------------------------------- #
# Stage 3 — login accounts (bcrypt-hashed)
# --------------------------------------------------------------------------- #
def _seed_users(emp_ids: dict):
    if user_col.count_documents({}) > 0:
        return
    for full, dept_code, designation, mgr_key, salary, role, join in PEOPLE:
        if full not in emp_ids:
            continue
        first, last = full.split(" ", 1)
        email = f"{first.lower()}.{last.lower().replace(' ', '')}@zentra.dev"
        user_col.insert_one({
            "email": email,
            "password_hash": hash_password("Password@123"),
            "role": role, "employee_id": emp_ids[full],
            "name": full, "status": "active",
            "created_at": now_utc(), "last_login": None})


# --------------------------------------------------------------------------- #
# Stage 4 — attendance for the last 42 calendar days (weekdays)
# --------------------------------------------------------------------------- #
def _times(day, ci_h, ci_m, co_h, co_m):
    """Build timezone-aware check-in/check-out datetimes for a business day."""
    from core import IST
    from datetime import datetime as _dt
    ci = _dt(day.year, day.month, day.day, ci_h, ci_m, random.randint(0, 59), tzinfo=IST)
    co = _dt(day.year, day.month, day.day, co_h, co_m, random.randint(0, 59), tzinfo=IST)
    return ci, co


def _seed_attendance(emp_ids: dict):
    if att_col.count_documents({}) > 0:
        return
    today = now_utc().date()
    docs = []
    for offset in range(42, -1, -1):
        day = today - timedelta(days=offset)
        if day.weekday() >= 5:            # weekends off
            continue
        date_str = day.strftime("%Y-%m-%d")
        for full, emp_oid in emp_ids.items():
            roll = random.random()
            if roll < 0.04:
                status, ci, co = "absent", None, None
            elif roll < 0.09:
                status, ci, co = "leave", None, None
            elif roll < 0.15:
                status = "wfh"
                ci, co = _times(day, 9, random.randint(0, 28), 18, random.randint(0, 45))
            elif roll < 0.21:
                status = "late"
                ci, co = _times(day, random.choice([10, 11]), random.randint(0, 59),
                                18, random.randint(15, 45))
            else:
                status = "present"
                ci, co = _times(day, 9, random.randint(0, 28), 18, random.randint(0, 59))
            hours = round((co - ci).total_seconds() / 3600, 2) if ci and co else None
            docs.append({
                "employee_id": emp_oid, "date": date_str,
                "check_in": ci.isoformat(timespec="seconds") if ci else None,
                "check_out": co.isoformat(timespec="seconds") if co else None,
                "hours_worked": hours, "status": status, "updated_at": now_utc()})
    if docs:
        try:
            att_col.insert_many(docs, ordered=False)
        except Exception:
            pass   # unique (employee, date) index dedupes any cold-start race


# --------------------------------------------------------------------------- #
# Stage 5 — leave history
# --------------------------------------------------------------------------- #
def _seed_leaves(emp_ids: dict):
    if lv_col.count_documents({}) > 0:
        return
    today = now_utc().date()
    for key, ltype, offset, length, status in LEAVE_SEED:
        emp_id = emp_ids.get(key)
        if not emp_id:
            continue
        start = today + timedelta(days=offset)
        end = start + timedelta(days=length - 1)
        emp = emp_col.find_one({"_id": emp_id}, {"manager_id": 1})
        approved = status == "approved"
        if approved:   # reflect the deduction the approval already made
            emp_col.update_one({"_id": emp_id},
                               {"$inc": {f"leave_balances.{ltype}": -length}})
        lv_col.insert_one({
            "employee_id": emp_id, "leave_type": ltype,
            "start_date": start.isoformat(), "end_date": end.isoformat(),
            "days": length, "reason": random.choice(REASONS[ltype]),
            "status": status,
            "reviewer_id": emp.get("manager_id") if status in ("approved", "rejected") else None,
            "review_comment": ("Approved — plan handovers" if approved else
                               "Team is at capacity this sprint" if status == "rejected" else None),
            "reviewed_at": now_utc() - timedelta(days=random.randint(1, 5))
                           if status in ("approved", "rejected") else None,
            "version": 1,
            "created_at": now_utc() - timedelta(days=random.randint(2, 20))})


# --------------------------------------------------------------------------- #
# Stage 6 — two completed payroll cycles
# --------------------------------------------------------------------------- #
def _seed_payroll():
    if run_col.count_documents({}) > 0:
        return
    today = now_utc().date()
    for back in (2, 1):
        y, m = today.year, today.month - back
        while m <= 0:
            m += 12
            y -= 1
        run = {"month": m, "year": y, "period": f"{y}-{m:02d}", "status": "processing",
               "created_by": None, "created_by_name": "System (seed)",
               "version": 1, "created_at": now_utc(), "completed_at": None,
               "total_employees": 0, "gross_total": 0, "net_total": 0}
        run_col.insert_one(run)
        active = list(emp_col.find({"status": "active"}))
        dept_names = {d["_id"]: d["name"] for d in dep_col.find({}, {"name": 1})}
        slips = []
        for e in active:
            slip = _payslip_for(e, m, y)
            slip["run_id"] = run["_id"]
            slip["department"] = dept_names.get(e.get("department_id"))
            slips.append(slip)
        slip_col.insert_many(slips)
        run_col.update_one({"_id": run["_id"]},
                           {"$set": {"status": "completed", "completed_at": now_utc(),
                                     "total_employees": len(slips),
                                     "gross_total": sum(s["gross"] for s in slips),
                                     "net_total": sum(s["net"] for s in slips)}})


def _seed():
    dept_ids = _seed_departments()
    emp_ids = _seed_employees(dept_ids)
    _seed_users(emp_ids)
    _seed_attendance(emp_ids)
    _seed_leaves(emp_ids)
    _seed_payroll()
    audit("SYSTEM_SEEDED", "system", None,
          {"message": f"Demo dataset provisioned for {APP_NAME}"},
          actor={"id": None, "name": "system", "role": "system"})


if __name__ == "__main__":
    _seed()
    print("Seed complete — login with admin@zentra.dev / Password@123")
