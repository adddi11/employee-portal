"""
routes_pay.py — Payroll processing APIs.

A payroll run is a heavy, money-sensitive operation protected by FOUR layers:

  1. Idempotency key  — a retried / double-clicked "Run Payroll" returns the
     original result instead of paying everyone twice.
  2. Unique index (year, month) — even two *different* admins racing on the
     same period collide at the database level; exactly one run can exist.
  3. ACID transaction — run document + all payslips + audit entry commit
     together or not at all (no half-processed pay runs, ever).
  4. Status/version CAS — a run can only be finalised from "processing" at the
     version observed, preventing concurrent finalisation.
"""
import calendar
from flask import Blueprint, request, g

from core import (ApiError, audit, clean, now_utc, oid, roles_required, run_transaction,
                  serialize, employees, payroll_runs, payslips, attendance,
                  with_idempotency, is_admin_hr, token_required)

bp = Blueprint("pay", __name__, url_prefix="/api/payroll")

MONTHS = ["", "January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def _payslip_for(emp: dict, month: int, year: int) -> dict:
    """Deterministic salary computation with a transparent breakdown."""
    base = int(emp.get("salary") or 0)
    hra = round(base * 0.20)            # House Rent Allowance
    conveyance = 800                    # flat conveyance allowance
    special = round(base * 0.10)        # special allowance
    gross = base + hra + conveyance + special
    pf = round(base * 0.12)             # provident fund (employee share)
    tax = round(gross * 0.10)           # simplified income tax slab
    prof_tax = 200                      # flat professional tax
    deductions = pf + tax + prof_tax

    period_prefix = f"{year}-{month:02d}"
    days_present = attendance.count_documents(
        {"employee_id": emp["_id"], "date": {"$regex": f"^{period_prefix}"},
         "status": {"$in": ["present", "late", "wfh"]}})

    return {
        "employee_id": emp["_id"],
        "emp_code": emp.get("emp_code"),
        "name": f"{emp.get('first_name', '')} {emp.get('last_name', '')}".strip(),
        "designation": emp.get("designation"),
        "department": emp.get("department_name"),
        "month": month, "year": year, "period": period_prefix,
        "base_salary": base, "hra": hra, "conveyance": conveyance, "special": special,
        "gross": gross, "pf": pf, "tax": tax, "prof_tax": prof_tax,
        "deductions": deductions, "net": gross - deductions,
        "days_present": days_present,
        "created_at": now_utc(),
    }


@bp.post("/runs")
@roles_required("admin", "hr")
def run_payroll():
    body = request.get_json(silent=True) or {}
    try:
        month, year = int(body.get("month")), int(body.get("year"))
    except (TypeError, ValueError):
        raise ApiError("month and year are required", 400)
    if not 1 <= month <= 12 or not 2000 <= year <= 2100:
        raise ApiError("month must be 1-12 and year a valid 4-digit value", 400)

    # NOTE: no route-level "already exists" pre-check here — that would short
    # -circuit idempotent replays. The unique (year, month) index inside the
    # transaction is the single source of truth for period uniqueness.

    def executor(session):
        run = {"month": month, "year": year, "period": f"{year}-{month:02d}",
               "status": "processing", "created_by": oid(g.user["id"]),
               "created_by_name": g.user.get("name") or g.user["email"],
               "version": 1, "created_at": now_utc(), "completed_at": None,
               "total_employees": 0, "gross_total": 0, "net_total": 0}
        try:
            payroll_runs.insert_one(run, session=session)   # unique (y,m) races here
        except Exception as exc:
            if "duplicate key" in str(exc).lower():
                raise ApiError(f"Payroll for {MONTHS[month]} {year} already exists", 409)
            raise

        active = list(employees.aggregate(
            [{"$match": {"status": "active"}}] +
            [{"$lookup": {"from": "departments", "localField": "department_id",
                          "foreignField": "_id", "as": "dept",
                          "pipeline": [{"$project": {"name": 1}}]}},
             {"$set": {"department_name": {"$arrayElemAt": ["$dept.name", 0]}}},
             {"$unset": "dept"}], session=session))
        if not active:
            raise ApiError("No active employees to process", 400)

        slip_docs = []
        for emp in active:
            slip = _payslip_for(emp, month, year)
            slip["run_id"] = run["_id"]
            slip_docs.append(slip)
        payslips.insert_many(slip_docs, session=session)

        gross_total = sum(s["gross"] for s in slip_docs)
        net_total = sum(s["net"] for s in slip_docs)
        # CAS finalisation — only from 'processing' at the version we created
        fin = payroll_runs.find_one_and_update(
            {"_id": run["_id"], "status": "processing", "version": 1},
            {"$set": {"status": "completed", "completed_at": now_utc(),
                      "total_employees": len(slip_docs),
                      "gross_total": gross_total, "net_total": net_total},
             "$inc": {"version": 1}}, session=session, return_document=True)
        if not fin:
            raise ApiError("Run was concurrently finalised — aborting", 409)

        audit("PAYROLL_RUN_EXECUTED", "payroll_run", run["_id"],
              {"period": f"{MONTHS[month]} {year}", "employees": len(slip_docs),
               "net_total": net_total}, session=session)
        return {
            "run": serialize(fin),
            "message": f"Payroll completed for {len(slip_docs)} employee(s) — "
                       f"₹{net_total:,} net disbursed",
        }, 201

    return with_idempotency("payroll-run", executor)


@bp.get("/runs")
@roles_required("admin", "hr")
def list_runs():
    docs = list(payroll_runs.find().sort([("year", -1), ("month", -1)]))
    return {"runs": serialize(docs)}


@bp.get("/runs/<run_id>")
@roles_required("admin", "hr")
def get_run(run_id):
    run = payroll_runs.find_one({"_id": oid(run_id)})
    if not run:
        raise ApiError("Payroll run not found", 404)
    slips = list(payslips.aggregate([
        {"$match": {"run_id": run["_id"]}},
        {"$sort": {"emp_code": 1}},
        {"$lookup": {"from": "employees", "localField": "employee_id",
                     "foreignField": "_id", "as": "emp",
                     "pipeline": [{"$project": {"first_name": 1, "last_name": 1}}]}},
        {"$set": {"name": {"$cond": [
            {"$gt": [{"$size": "$emp"}, 0]},
            {"$trim": {"input": {"$concat": [
                {"$arrayElemAt": ["$emp.first_name", 0]}, " ",
                {"$arrayElemAt": ["$emp.last_name", 0]}]}}},
            "$name"]}}},
        {"$unset": "emp"},
    ]))
    return {"run": serialize(run), "payslips": serialize(slips)}


@bp.get("/payslips/mine")
@token_required
def my_payslips():
    docs = list(payslips.aggregate([
        {"$match": {"employee_id": oid(g.user["emp_id"])}},
        {"$sort": {"year": -1, "month": -1}},
        {"$lookup": {"from": "payroll_runs", "localField": "run_id",
                     "foreignField": "_id", "as": "run",
                     "pipeline": [{"$project": {"status": 1, "completed_at": 1}}]}},
        {"$set": {"run_status": {"$arrayElemAt": ["$run.status", 0]}}},
        {"$unset": "run"},
    ]))
    return {"payslips": serialize(docs)}


@bp.get("/payslips/<slip_id>")
@token_required
def get_payslip(slip_id):
    slip = payslips.find_one({"_id": oid(slip_id)})
    if not slip:
        raise ApiError("Payslip not found", 404)
    if not is_admin_hr() and str(slip["employee_id"]) != g.user["emp_id"]:
        raise ApiError("You can only view your own payslips", 403)
    return {"payslip": serialize(slip)}
