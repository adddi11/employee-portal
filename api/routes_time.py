"""
routes_time.py — Attendance tracking & Leave workflow APIs.

Concurrency correctness (the heart of the design):

  * CHECK-IN  — the unique compound index (employee_id, date) makes duplicate
    check-ins physically impossible; the loser of a race gets DuplicateKeyError
    → HTTP 409.

  * CHECK-OUT — compare-and-set update (``check_out`` must still be absent);
    two concurrent check-outs → exactly one wins.

  * LEAVE APPROVAL — three interlocking guards:
      1. Optimistic locking (version field): the reviewer update only matches
         ``{status: "pending", version: N}`` — a concurrent reviewer loses with
         a clean 409 instead of double-approving.
      2. Atomic conditional balance decrement: ``leave_balances.<type> >= days``
         is enforced *inside* the update predicate, so an overdraw can never
         commit (this is the "row-level lock" equivalent in MongoDB).
      3. The whole block runs in an ACID multi-document transaction when the
         deployment supports it — any failure rolls back the status flip AND
         the balance write together.

  * LEAVE APPLY — protected by the idempotency-key engine (retries / double
    clicks can never create duplicate requests).
"""
from flask import Blueprint, request, g

from core import (ApiError, EMPLOYEE_LOOKUP, DEFAULT_BALANCES, LEAVE_TYPES, audit, clean,
                  ist_minutes, now_utc, oid, roles_required, run_transaction, serialize,
                  token_required, WORK_START, attendance, employees, leave_requests,
                  with_idempotency, current_scope_ids, is_admin_hr, today_ist)

bp = Blueprint("time", __name__, url_prefix="/api")

DAY = 60 * 60 * 24


def _valid_date(s: str) -> bool:
    import re
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", s or ""))


def _iso_time(dt) -> str:
    return dt.isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# Attendance
# --------------------------------------------------------------------------- #
@bp.post("/attendance/check-in")
@token_required
def check_in():
    if not g.user.get("emp_id"):
        raise ApiError("This account is not linked to an employee record", 400)
    emp_id = oid(g.user["emp_id"])
    date = today_ist()
    minutes = ist_minutes()
    late = minutes > WORK_START[0] * 60 + WORK_START[1]

    doc = {
        "employee_id": emp_id, "date": date,
        "check_in": _iso_time(now_utc()), "check_out": None, "hours_worked": None,
        "status": "late" if late else "present",
        "updated_at": now_utc(),
    }
    try:
        attendance.insert_one(doc)          # unique (employee_id, date) guards races
    except Exception as exc:
        if "duplicate key" in str(exc).lower():
            raise ApiError("You have already checked in today", 409)
        raise
    audit("ATTENDANCE_CHECKIN", "attendance", doc["_id"],
          {"date": date, "status": doc["status"]})
    return {"attendance": serialize(doc),
            "message": "Checked in" + (" — marked late" if late else "")}, 201


@bp.post("/attendance/check-out")
@token_required
def check_out():
    emp_id = oid(g.user["emp_id"])
    rec = attendance.find_one({"employee_id": emp_id, "date": today_ist()})
    if not rec:
        raise ApiError("No check-in found for today", 404)
    out_time = now_utc()
    raw_in = rec["check_in"]
    if isinstance(raw_in, str):
        from datetime import datetime
        check_in_dt = datetime.fromisoformat(raw_in)
    else:
        check_in_dt = raw_in
    hours = round((out_time - check_in_dt).total_seconds() / 3600, 2)
    # Compare-and-set: only one concurrent check-out can win
    result = attendance.update_one(
        {"_id": rec["_id"], "check_out": None},
        {"$set": {"check_out": _iso_time(out_time), "hours_worked": hours,
                  "updated_at": now_utc()}})
    if result.matched_count == 0:
        raise ApiError("You have already checked out today", 409)
    audit("ATTENDANCE_CHECKOUT", "attendance", rec["_id"], {"hours": hours})
    return {"attendance": serialize(attendance.find_one({"_id": rec["_id"]})),
            "message": f"Checked out — {hours}h logged"}


@bp.get("/attendance/today")
@token_required
def attendance_today():
    rec = attendance.find_one({"employee_id": oid(g.user["emp_id"]), "date": today_ist()})
    return {"attendance": serialize(rec)}


@bp.get("/attendance")
@token_required
def list_attendance():
    month = clean(request.args.get("month"), 7)          # YYYY-MM
    employee_id = clean(request.args.get("employee_id"), 40)
    status = clean(request.args.get("status"), 12)

    match: dict = {}
    scope = current_scope_ids()
    if scope is not None:
        if employee_id:
            if oid(employee_id) not in scope:
                raise ApiError("You can only view attendance within your team", 403)
            match["employee_id"] = oid(employee_id)
        else:
            match["employee_id"] = {"$in": list(scope)}
    elif employee_id:
        match["employee_id"] = oid(employee_id)
    if month:
        if not _valid_date(f"{month}-01"):
            raise ApiError("month must be in YYYY-MM format", 400)
        match["date"] = {"$regex": f"^{month}"}
    if status:
        match["status"] = status

    docs = list(attendance.aggregate([
        {"$match": match}, {"$sort": {"date": -1}}, {"$limit": 400},
        {"$lookup": {"from": "employees", "localField": "employee_id",
                     "foreignField": "_id", "as": "emp",
                     "pipeline": [{"$project": {"first_name": 1, "last_name": 1, "emp_code": 1}}]}},
        {"$set": {"employee_name": {"$trim": {"input": {"$concat": [
            {"$arrayElemAt": ["$emp.first_name", 0]}, " ",
            {"$arrayElemAt": ["$emp.last_name", 0]}]}}},
            "emp_code": {"$arrayElemAt": ["$emp.emp_code", 0]}}},
        {"$unset": "emp"},
    ]))
    summary: dict = {}
    for d in docs:
        summary[d["status"]] = summary.get(d["status"], 0) + 1
    return {"attendance": serialize(docs), "summary": summary}


# --------------------------------------------------------------------------- #
# Leave workflow
# --------------------------------------------------------------------------- #
def _leave_days(start: str, end: str) -> int:
    from datetime import date as _date
    a = _date.fromisoformat(start)
    b = _date.fromisoformat(end)
    return (b - a).days + 1


@bp.post("/leaves")
@token_required
def apply_leave():
    if not g.user.get("emp_id"):
        raise ApiError("This account is not linked to an employee record", 400)
    body = request.get_json(silent=True) or {}
    emp_id = oid(g.user["emp_id"])

    leave_type = clean(body.get("leave_type"), 12).lower()
    start, end = clean(body.get("start_date"), 10), clean(body.get("end_date"), 10)
    reason = clean(body.get("reason"), 400)
    if leave_type not in LEAVE_TYPES:
        raise ApiError(f"leave_type must be one of: {', '.join(LEAVE_TYPES)}", 400)
    if not _valid_date(start) or not _valid_date(end):
        raise ApiError("start_date and end_date must be YYYY-MM-DD", 400)
    if end < start:
        raise ApiError("end_date cannot be before start_date", 400)
    if not reason:
        raise ApiError("Please add a short reason for your request", 400)
    days = _leave_days(start, end)
    if days > 45:
        raise ApiError("Requests longer than 45 days need HR to apply on your behalf", 400)

    employee = employees.find_one({"_id": emp_id}, {"leave_balances": 1, "status": 1})
    if not employee or employee.get("status") != "active":
        raise ApiError("Your employee record is inactive", 403)
    if employee.get("leave_balances", {}).get(leave_type, 0) < days:
        raise ApiError(f"Insufficient {leave_type} balance for {days} day(s)", 400)

    def executor(session):
        doc = {"employee_id": emp_id, "leave_type": leave_type,
               "start_date": start, "end_date": end, "days": days, "reason": reason,
               "status": "pending", "reviewer_id": None, "review_comment": None,
               "reviewed_at": None, "version": 1, "created_at": now_utc()}
        leave_requests.insert_one(doc, session=session)
        audit("LEAVE_APPLIED", "leave_request", doc["_id"],
              {"type": leave_type, "days": days, "start": start, "end": end},
              session=session)
        return {"leave": serialize(doc), "message": "Leave request submitted"}, 201

    return with_idempotency("leave-apply", executor)


@bp.get("/leaves")
@token_required
def list_leaves():
    scope = clean(request.args.get("scope", "mine"), 8)
    status = clean(request.args.get("status"), 12)
    if scope == "all" and not is_admin_hr():
        raise ApiError("Only HR/Admin can browse every leave request", 403)
    if scope == "team" and g.user["role"] not in ("admin", "hr", "manager"):
        raise ApiError("Only managers and above have a team view", 403)

    match: dict = {}
    if scope == "mine":
        match["employee_id"] = oid(g.user["emp_id"])
    elif scope == "team":
        reports = [d["_id"] for d in employees.find({"manager_id": oid(g.user["emp_id"])},
                                                    {"_id": 1})]
        match["employee_id"] = {"$in": reports or [oid(g.user["emp_id"])]}
    if status:
        match["status"] = status

    docs = list(leave_requests.aggregate([
        {"$match": match}, {"$sort": {"created_at": -1}}, {"$limit": 250},
        {"$lookup": {"from": "employees", "localField": "employee_id", "foreignField": "_id",
                     "as": "emp", "pipeline": [{"$project": {"first_name": 1, "last_name": 1,
                                                             "emp_code": 1}}]}},
        {"$lookup": {"from": "users", "localField": "reviewer_id", "foreignField": "_id",
                     "as": "rev", "pipeline": [{"$project": {"name": 1}}]}},
        {"$set": {
            "employee_name": {"$trim": {"input": {"$concat": [
                {"$arrayElemAt": ["$emp.first_name", 0]}, " ",
                {"$arrayElemAt": ["$emp.last_name", 0]}]}}},
            "emp_code": {"$arrayElemAt": ["$emp.emp_code", 0]},
            "reviewer_name": {"$arrayElemAt": ["$rev.name", 0]}}},
        {"$unset": ["emp", "rev"]},
    ]))
    return {"leaves": serialize(docs)}


@bp.get("/leaves/balances/me")
@token_required
def my_balances():
    emp = employees.find_one({"_id": oid(g.user["emp_id"])}, {"leave_balances": 1})
    if not emp:
        raise ApiError("No employee record linked to this account", 404)
    balances = emp.get("leave_balances", {})
    year = now_utc().strftime("%Y")
    used: dict = {}
    for t in LEAVE_TYPES:
        pipeline = [{"$match": {"employee_id": emp["_id"], "status": "approved",
                                "leave_type": t, "start_date": {"$regex": f"^{year}"}}},
                    {"$group": {"_id": None, "days": {"$sum": "$days"}}}]
        row = next(iter(list(leave_requests.aggregate(pipeline))), None)
        used[t] = row["days"] if row else 0
    # NOTE: the live balance field already reflects every approval deduction,
    # so "remaining" reads straight from it — "used" is a reporting stat only.
    return {"balances": {t: {"total": DEFAULT_BALANCES.get(t, balances.get(t, 0)),
                             "used": used.get(t, 0),
                             "remaining": max(0, balances.get(t, 0))}
                         for t in LEAVE_TYPES}}


@bp.get("/leaves/pending/count")
@token_required
def pending_count():
    match = {"status": "pending"}
    if not is_admin_hr():
        if g.user["role"] == "manager":
            reports = [d["_id"] for d in employees.find(
                {"manager_id": oid(g.user["emp_id"])}, {"_id": 1})]
            match["employee_id"] = {"$in": reports}
        else:
            match["employee_id"] = oid(g.user["emp_id"])
    return {"count": leave_requests.count_documents(match)}


def _can_review(leave: dict) -> None:
    """Authorisation for approve/reject — managers may only act on direct reports."""
    if is_admin_hr():
        return
    if g.user["role"] != "manager":
        raise ApiError("You do not have permission to review leave requests", 403)
    emp = employees.find_one({"_id": leave["employee_id"]}, {"manager_id": 1})
    if not emp or str(emp.get("manager_id")) != g.user["emp_id"]:
        raise ApiError("You can only review requests from your direct reports", 403)


def _review_leave(leave_id, decision: str, comment: str):
    leave = leave_requests.find_one({"_id": leave_id})
    if not leave:
        raise ApiError("Leave request not found", 404)
    _can_review(leave)
    if leave["status"] != "pending":
        raise ApiError(f"This request was already {leave['status']}", 409)

    reviewer = oid(g.user["id"])
    patch = {"status": decision, "reviewer_id": reviewer,
             "review_comment": comment or None, "reviewed_at": now_utc()}

    def executor(session):
        # Guard 1 — optimistic lock: matches ONLY while still pending at the
        # version we read. A concurrent reviewer's update changes version, so
        # our update matches nothing → clean 409, never a double decision.
        cas = leave_requests.find_one_and_update(
            {"_id": leave["_id"], "status": "pending", "version": leave["version"]},
            {"$set": patch, "$inc": {"version": 1}}, session=session)
        if not cas:
            raise ApiError("Concurrent update detected — someone already reviewed "
                           "this request", 409)

        if decision == "approved":
            # Guard 2 — atomic conditional decrement: the balance check lives
            # INSIDE the update predicate, so the balance can never go negative.
            res = employees.update_one(
                {"_id": leave["employee_id"],
                 f"leave_balances.{leave['leave_type']}": {"$gte": leave["days"]}},
                {"$inc": {f"leave_balances.{leave['leave_type']}": -leave["days"]}},
                session=session)
            if res.matched_count == 0:
                if session:      # transaction → abort rolls back the status flip too
                    raise ApiError(f"Insufficient {leave['leave_type']} balance — "
                                   f"approval rolled back", 409)
                # non-transactional fallback → compensating write
                leave_requests.update_one(
                    {"_id": leave["_id"], "status": "approved", "version": leave["version"] + 1},
                    {"$set": {"status": "pending", "reviewer_id": None, "reviewed_at": None},
                     "$inc": {"version": 1}})
                raise ApiError(f"Insufficient {leave['leave_type']} balance — "
                               f"approval rolled back", 409)

        audit(f"LEAVE_{decision.upper()}", "leave_request", leave["_id"],
              {"employee_id": str(leave["employee_id"]), "type": leave["leave_type"],
               "days": leave["days"], "comment": comment or None}, session=session)
        fresh = leave_requests.find_one({"_id": leave["_id"]}, session=session)
        return {"leave": serialize(fresh),
                "message": f"Leave {decision}" +
                           (f" — {leave['days']} day(s) deducted" if decision == 'approved' else "")}, 200

    return run_transaction(executor)


@bp.post("/leaves/<leave_id>/approve")
@roles_required("admin", "hr", "manager")
def approve_leave(leave_id):
    body = request.get_json(silent=True) or {}
    return _review_leave(oid(leave_id), "approved", clean(body.get("comment"), 200))


@bp.post("/leaves/<leave_id>/reject")
@roles_required("admin", "hr", "manager")
def reject_leave(leave_id):
    body = request.get_json(silent=True) or {}
    return _review_leave(oid(leave_id), "rejected", clean(body.get("comment"), 200))


@bp.post("/leaves/<leave_id>/cancel")
@token_required
def cancel_leave(leave_id):
    leave = leave_requests.find_one({"_id": oid(leave_id)})
    if not leave:
        raise ApiError("Leave request not found", 404)
    if str(leave["employee_id"]) != g.user["emp_id"]:
        raise ApiError("You can only cancel your own requests", 403)
    if leave["status"] != "pending":
        raise ApiError("Only pending requests can be cancelled", 409)
    leave_requests.update_one({"_id": leave["_id"], "status": "pending"},
                              {"$set": {"status": "cancelled"}, "$inc": {"version": 1}})
    audit("LEAVE_CANCELLED", "leave_request", leave["_id"],
          {"type": leave["leave_type"], "days": leave["days"]})
    return {"ok": True, "message": "Request cancelled"}
