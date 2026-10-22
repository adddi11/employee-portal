"""
routes_misc.py — Dashboard analytics, audit-trail browsing and health check.

The dashboard endpoint is role-aware: every caller receives the exact tiles
they are allowed to see — executives get organisation-wide analytics, managers
get team views, employees get a personal workspace summary.
"""
from flask import Blueprint, request, g

from core import (ApiError, LEAVE_TYPES, audit, clean, is_admin_hr, now_utc, oid,
                  roles_required, serialize, token_required, today_ist,
                  attendance, audit_logs, departments, employees, leave_requests,
                  payroll_runs, payslips, current_scope_ids)

bp = Blueprint("misc", __name__, url_prefix="/api")


@bp.get("/health")
def health():
    from core import client
    ping = False
    try:
        client.admin.command("ping")
        ping = True
    except Exception:
        pass
    from seed import ensure_seeded
    ensure_seeded()
    return {"status": "ok" if ping else "degraded", "database": ping, "time": now_utc().isoformat()}


@bp.get("/dashboard")
@token_required
def dashboard():
    role = g.user["role"]
    me_emp = employees.find_one({"_id": oid(g.user["emp_id"])}) if g.user.get("emp_id") else None
    today = today_ist()
    month_prefix = today[:7]
    data: dict = {"role": role, "date": today, "me": None}

    if me_emp:
        name = f"{me_emp.get('first_name', '')} {me_emp.get('last_name', '')}".strip()
        data["me"] = {"name": name or g.user["name"], "designation": me_emp.get("designation"),
                      "emp_code": me_emp.get("emp_code"),
                      "leave_balances": me_emp.get("leave_balances", {})}

    # ---- personal tiles (all roles) ----
    if me_emp:
        my_month = list(attendance.find(
            {"employee_id": me_emp["_id"], "date": {"$regex": f"^{month_prefix}"}},
            {"status": 1}))
        counts: dict = {}
        for r in my_month:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        data["my_month"] = {"summary": counts,
                            "working_days": len(my_month)}
        pending = list(leave_requests.aggregate([
            {"$match": {"employee_id": me_emp["_id"], "status": "pending"}},
            {"$sort": {"created_at": -1}}, {"$limit": 4}]))
        data["my_pending_leaves"] = serialize(pending)
        latest_slip = payslips.find_one({"employee_id": me_emp["_id"]},
                                        sort=[("year", -1), ("month", -1)])
        data["latest_payslip"] = serialize(latest_slip)

    # ---- organisation tiles (admin / hr) ----
    if role in ("admin", "hr"):
        active = employees.count_documents({"status": "active"})
        total = employees.count_documents({})
        new_this_month = employees.count_documents(
            {"join_date": {"$regex": f"^{month_prefix}"}})
        data["headcount"] = {"active": active, "total": total,
                             "inactive": total - active, "new_this_month": new_this_month}

        by_dept = list(employees.aggregate([
            {"$match": {"status": "active"}},
            {"$group": {"_id": "$department_id", "count": {"$sum": 1}}},
            {"$lookup": {"from": "departments", "localField": "_id",
                         "foreignField": "_id", "as": "d",
                         "pipeline": [{"$project": {"name": 1}}]}},
            {"$set": {"name": {"$ifNull": [{"$arrayElemAt": ["$d.name", 0]}, "Unassigned"]}}},
            {"$unset": "d"}, {"$sort": {"count": -1}}]))
        data["by_department"] = [{"name": r["name"], "count": r["count"]} for r in by_dept]

        trend = _attendance_trend(7)
        data["attendance_trend"] = trend
        data["today_attendance"] = _status_counts(today)

        data["pending_approvals"] = _pending_list(6)
        data["pending_count"] = leave_requests.count_documents({"status": "pending"})

        leave_mix = list(leave_requests.aggregate(
            [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]))
        data["leave_mix"] = {r["_id"]: r["n"] for r in leave_mix}

        runs = list(payroll_runs.find({"status": "completed"})
                    .sort([("year", -1), ("month", -1)]).limit(3))
        data["recent_runs"] = serialize(runs)
        data["recent_audit"] = serialize(list(
            audit_logs.find().sort("created_at", -1).limit(6)))

    # ---- team tiles (manager) ----
    if role == "manager":
        reports = list(employees.find({"manager_id": me_emp["_id"], "status": "active"}
                                      if me_emp else {"status": "active"},
                                      {"first_name": 1, "last_name": 1, "emp_code": 1,
                                       "designation": 1, "department_id": 1}))
        data["team_size"] = len(reports)
        report_ids = [r["_id"] for r in reports]
        if report_ids:
            data["team_today"] = _status_counts(today, report_ids)
        data["pending_approvals"] = _pending_list(6, report_ids)
        data["pending_count"] = leave_requests.count_documents(
            {"status": "pending", "employee_id": {"$in": report_ids or [None]}})

    return serialize(data)


def _status_counts(date: str, employee_ids=None):
    match = {"date": date}
    if employee_ids is not None:
        match["employee_id"] = {"$in": employee_ids}
    rows = attendance.aggregate([{"$match": match},
                                 {"$group": {"_id": "$status", "n": {"$sum": 1}}}])
    return {r["_id"]: r["n"] for r in rows}


def _attendance_trend(days: int):
    from datetime import timedelta, timezone
    out = []
    base = now_utc().astimezone(timezone(timedelta(hours=5, minutes=30))).date()
    dates = [(base - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)][::-1]
    rows = attendance.aggregate([
        {"$match": {"date": {"$in": dates}}},
        {"$group": {"_id": {"date": "$date", "status": "$status"}, "n": {"$sum": 1}}}])
    grid = {d: {} for d in dates}
    for r in rows:
        grid[r["_id"]["date"]][r["_id"]["status"]] = r["n"]
    for d in dates:
        row = grid[d]
        present = row.get("present", 0)
        late = row.get("late", 0)
        wfh = row.get("wfh", 0)
        absent = row.get("absent", 0) + row.get("leave", 0)
        out.append({"date": d, "present": present, "late": late, "wfh": wfh,
                    "absent": absent})
    return out


def _pending_list(limit: int, employee_ids=None):
    match: dict = {"status": "pending"}
    if employee_ids is not None:
        match["employee_id"] = {"$in": employee_ids}
    return serialize(list(leave_requests.aggregate([
        {"$match": match}, {"$sort": {"created_at": 1}}, {"$limit": limit},
        {"$lookup": {"from": "employees", "localField": "employee_id",
                     "foreignField": "_id", "as": "emp",
                     "pipeline": [{"$project": {"first_name": 1, "last_name": 1}}]}},
        {"$set": {"employee_name": {"$trim": {"input": {"$concat": [
            {"$arrayElemAt": ["$emp.first_name", 0]}, " ",
            {"$arrayElemAt": ["$emp.last_name", 0]}]}}}}},
        {"$unset": "emp"}])))


@bp.get("/audit")
@roles_required("admin", "hr")
def browse_audit():
    action = clean(request.args.get("action"), 40).upper()
    q = clean(request.args.get("q"), 60)
    limit = min(300, max(1, int(request.args.get("limit", 100) or 100)))
    match: dict = {}
    if action:
        match["action"] = {"$regex": f"^{action}"}
    if q:
        match["actor_name"] = {"$regex": q, "$options": "i"}
    docs = list(audit_logs.find(match).sort("created_at", -1).limit(limit))
    actions = sorted({d["action"] for d in audit_logs.find({}, {"action": 1, "_id": 0})})
    return {"logs": serialize(docs), "actions": actions}
