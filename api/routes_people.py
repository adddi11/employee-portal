"""
routes_people.py — Employee records & department hierarchy APIs.

Employee onboarding runs inside an ACID transaction: the employee record and
its linked login account are created together or not at all (no orphaned
records). Unique indexes on emp_code + email enforce data integrity, and
every mutation is audit-logged.
"""
from flask import Blueprint, request, g

from core import (ApiError, DEFAULT_BALANCES, EMPLOYEE_LOOKUP, audit, clean, now_utc,
                  oid, roles_required, run_transaction, serialize, EMAIL_RE,
                  employees, departments, users, hash_password, is_admin_hr,
                  current_scope_ids, token_required)

bp = Blueprint("people", __name__, url_prefix="/api")

FULL_COLS = ("salary", "leave_balances")   # hidden from non admin/hr eyes


def _visible_employee(doc: dict) -> dict:
    if is_admin_hr():
        return doc
    return {k: v for k, v in doc.items() if k not in FULL_COLS}


def _next_emp_code(session=None) -> str:
    last = employees.find_one(sort=[("emp_code", -1)], projection={"emp_code": 1})
    try:
        n = int(last["emp_code"].split("-")[1]) + 1 if last else 1001
    except (ValueError, IndexError):
        n = 1001
    return f"ZT-{n}"


# --------------------------------------------------------------------------- #
# Employees
# --------------------------------------------------------------------------- #
@bp.get("/employees")
@token_required
def list_employees():
    q = clean(request.args.get("q"), 80)
    dept = clean(request.args.get("department_id"), 60)
    status = clean(request.args.get("status"), 20)

    match: dict = {}
    if status in ("active", "inactive"):
        match["status"] = status
    if dept:
        match["department_id"] = oid(dept)
    if q:
        rx = {"$regex": f"{q}", "$options": "i"}
        match["$or"] = [{"first_name": rx}, {"last_name": rx}, {"email": rx},
                        {"emp_code": rx}, {"designation": rx}]
    scope = current_scope_ids()
    if scope is not None:
        match["_id"] = {"$in": list(scope)}

    docs = list(employees.aggregate(
        [{"$match": match}, {"$sort": {"emp_code": 1}}] + EMPLOYEE_LOOKUP))
    return {"employees": [_visible_employee(serialize(d)) for d in docs]}


@bp.get("/employees/<emp_id>")
@token_required
def get_employee(emp_id):
    doc = next(iter(list(employees.aggregate(
        [{"$match": {"_id": oid(emp_id)}}] + EMPLOYEE_LOOKUP))), None)
    if not doc:
        raise ApiError("Employee not found", 404)
    return {"employee": _visible_employee(serialize(doc))}


@bp.post("/employees")
@roles_required("admin", "hr")
def onboard_employee():
    """Employee onboarding — creates the employee record AND its login account
    atomically (transaction). Unique indexes reject duplicate email / emp_code."""
    body = request.get_json(silent=True) or {}
    first = clean(body.get("first_name"), 60)
    last = clean(body.get("last_name"), 60)
    email = clean(body.get("email"), 120).lower()
    if not first or not last:
        raise ApiError("First and last name are required", 400)
    if not EMAIL_RE.match(email):
        raise ApiError("A valid email address is required", 400)

    dept_id = oid(body["department_id"]) if body.get("department_id") else None
    mgr_id = oid(body["manager_id"]) if body.get("manager_id") else None
    if dept_id and not departments.find_one({"_id": dept_id}):
        raise ApiError("Selected department does not exist", 400)
    if mgr_id and not employees.find_one({"_id": mgr_id}):
        raise ApiError("Selected manager does not exist", 400)

    role = body.get("account_role", "employee")
    if role not in ("admin", "hr", "manager", "employee"):
        raise ApiError("Invalid account role", 400)
    if role in ("admin", "hr") and g.user["role"] != "admin":
        raise ApiError("Only an admin can grant admin/HR accounts", 403)

    try:
        salary = max(0, int(float(body.get("salary") or 0)))
    except (TypeError, ValueError):
        raise ApiError("Salary must be a number", 400)
    if salary <= 0:
        raise ApiError("Monthly salary is required for payroll", 400)

    balances = DEFAULT_BALANCES.copy()
    for k in balances:
        try:
            balances[k] = max(0, int(body.get("leave_balances", {}).get(k, balances[k])))
        except (TypeError, ValueError):
            pass

    password = clean(body.get("password"), 64) or "Password@123"
    if len(password) < 8:
        raise ApiError("Account password must be at least 8 characters", 400)

    if employees.find_one({"email": email}) or users.find_one({"email": email}):
        raise ApiError(f"An employee with email '{email}' already exists", 409)

    def executor(session):
        emp_doc = {
            "emp_code": _next_emp_code(session),
            "first_name": first, "last_name": last, "email": email,
            "phone": clean(body.get("phone"), 20) or None,
            "department_id": dept_id, "manager_id": mgr_id,
            "designation": clean(body.get("designation"), 80) or "Employee",
            "employment_type": body.get("employment_type", "full_time"),
            "join_date": clean(body.get("join_date"), 10) or now_utc().strftime("%Y-%m-%d"),
            "status": "active",
            "salary": salary,
            "leave_balances": balances,
            "created_at": now_utc(), "updated_at": now_utc(),
        }
        result = employees.insert_one(emp_doc, session=session)
        emp_doc["_id"] = result.inserted_id

        try:
            users.insert_one({
                "email": email,
                "password_hash": hash_password(password),
                "role": role,
                "employee_id": result.inserted_id,
                "name": f"{first} {last}".strip(),
                "status": "active",
                "created_at": now_utc(), "last_login": None,
            }, session=session)
        except Exception as exc:
            if "duplicate key" in str(exc).lower():
                raise ApiError(f"An account with email '{email}' already exists", 409)
            raise
        audit("EMPLOYEE_ONBOARDED", "employee", result.inserted_id,
              {"emp_code": emp_doc["emp_code"], "email": email,
               "department": str(dept_id or "-"), "role": role}, session=session)
        return {"employee": serialize(emp_doc),
                     "message": f"{first} onboarded with a working {role} account"}, 201

    return run_transaction(executor)


@bp.put("/employees/<emp_id>")
@roles_required("admin", "hr")
def update_employee(emp_id):
    body = request.get_json(silent=True) or {}
    emp = employees.find_one({"_id": oid(emp_id)})
    if not emp:
        raise ApiError("Employee not found", 404)

    updates: dict = {"updated_at": now_utc()}
    for field, limit in (("first_name", 60), ("last_name", 60), ("phone", 20),
                         ("designation", 80), ("employment_type", 20),
                         ("join_date", 10), ("status", 12)):
        if field in body:
            updates[field] = clean(body.get(field), limit) or None
    if updates.get("status") not in (None, "active", "inactive"):
        raise ApiError("Status must be active or inactive", 400)

    if "salary" in body and is_admin_hr():
        try:
            updates["salary"] = max(0, int(float(body["salary"])))
        except (TypeError, ValueError):
            raise ApiError("Salary must be a number", 400)
    if "department_id" in body:
        updates["department_id"] = oid(body["department_id"]) if body["department_id"] else None
    if "manager_id" in body:
        mgr = oid(body["manager_id"]) if body["manager_id"] else None
        if mgr and (str(mgr) == str(emp["_id"])):
            raise ApiError("An employee cannot report to themselves", 400)
        updates["manager_id"] = mgr

    employees.update_one({"_id": emp["_id"]}, {"$set": updates})
    # keep the login account in sync (status + role changes)
    if "status" in updates:
        users.update_one({"employee_id": emp["_id"]},
                         {"$set": {"status": "active" if updates["status"] == "active"
                                   else "disabled"}})
    if body.get("account_role") and g.user["role"] == "admin":
        role = body["account_role"]
        if role in ("admin", "hr", "manager", "employee"):
            users.update_one({"employee_id": emp["_id"]}, {"$set": {"role": role}})
            audit("ACCOUNT_ROLE_CHANGED", "employee", emp["_id"],
                  {"new_role": role})
    audit("EMPLOYEE_UPDATED", "employee", emp["_id"],
          {"fields": [k for k in updates if k != "updated_at"]})
    doc = next(iter(list(employees.aggregate(
        [{"$match": {"_id": emp["_id"]}}] + EMPLOYEE_LOOKUP))), None)
    return {"employee": _visible_employee(serialize(doc)), "message": "Employee updated"}


@bp.delete("/employees/<emp_id>")
@roles_required("admin")
def deactivate_employee(emp_id):
    """Soft delete — records are never destroyed (payroll/audit history)."""
    emp = employees.find_one({"_id": oid(emp_id)})
    if not emp:
        raise ApiError("Employee not found", 404)
    if str(emp["_id"]) == g.user["emp_id"]:
        raise ApiError("You cannot deactivate your own account", 400)
    employees.update_one({"_id": emp["_id"]},
                         {"$set": {"status": "inactive", "updated_at": now_utc()}})
    users.update_many({"employee_id": emp["_id"]}, {"$set": {"status": "disabled"}})
    audit("EMPLOYEE_DEACTIVATED", "employee", emp["_id"],
          {"emp_code": emp.get("emp_code")})
    return {"ok": True, "message": "Employee deactivated (soft delete)"}


# --------------------------------------------------------------------------- #
# Departments — self-referencing hierarchy (parent_id)
# --------------------------------------------------------------------------- #
@bp.get("/departments")
@token_required
def list_departments():
    docs = list(departments.aggregate([
        {"$lookup": {"from": "employees", "localField": "head_id", "foreignField": "_id",
                     "as": "head", "pipeline": [{"$project": {"first_name": 1, "last_name": 1}}]}},
        {"$set": {"head_name": {"$cond": [
            {"$gt": [{"$size": "$head"}, 0]},
            {"$trim": {"input": {"$concat": [
                {"$arrayElemAt": ["$head.first_name", 0]}, " ",
                {"$arrayElemAt": ["$head.last_name", 0]}]}}},
            None]}}},
        {"$lookup": {"from": "employees", "localField": "_id",
                     "foreignField": "department_id", "as": "members",
                     "pipeline": [{"$match": {"status": "active"}}, {"$count": "n"}]}},
        {"$set": {"employee_count": {"$ifNull": [{"$arrayElemAt": ["$members.n", 0]}, 0]}}},
        {"$unset": ["head", "members"]},
        {"$sort": {"name": 1}},
    ]))
    return {"departments": serialize(docs)}


@bp.post("/departments")
@roles_required("admin", "hr")
def create_department():
    body = request.get_json(silent=True) or {}
    name = clean(body.get("name"), 80)
    code = clean(body.get("code"), 12).upper()
    if not name or not code:
        raise ApiError("Department name and code are required", 400)
    parent = oid(body["parent_id"]) if body.get("parent_id") else None
    if parent and not departments.find_one({"_id": parent}):
        raise ApiError("Parent department does not exist", 400)
    head = oid(body["head_id"]) if body.get("head_id") else None
    if head and not employees.find_one({"_id": head}):
        raise ApiError("Department head does not exist", 400)

    doc = {"name": name, "code": code, "parent_id": parent, "head_id": head,
           "description": clean(body.get("description"), 240) or None,
           "created_at": now_utc()}
    try:
        departments.insert_one(doc)
    except Exception as exc:
        if "duplicate key" in str(exc).lower():
            raise ApiError(f"Department code '{code}' already exists", 409)
        raise
    audit("DEPARTMENT_CREATED", "department", doc["_id"], {"name": name, "code": code})
    return {"department": serialize(doc), "message": f"Department '{name}' created"}, 201


@bp.put("/departments/<dept_id>")
@roles_required("admin", "hr")
def update_department(dept_id):
    body = request.get_json(silent=True) or {}
    dept = departments.find_one({"_id": oid(dept_id)})
    if not dept:
        raise ApiError("Department not found", 404)
    updates: dict = {}
    for field, limit in (("name", 80), ("code", 12), ("description", 240)):
        if field in body:
            updates[field] = clean(body.get(field), limit) or None
    if "code" in updates and updates["code"]:
        updates["code"] = updates["code"].upper()
    if "parent_id" in body:
        parent = oid(body["parent_id"]) if body["parent_id"] else None
        if parent and str(parent) == str(dept["_id"]):
            raise ApiError("A department cannot be its own parent", 400)
        if parent and not departments.find_one({"_id": parent}):
            raise ApiError("Parent department does not exist", 400)
        updates["parent_id"] = parent
    if "head_id" in body:
        head = oid(body["head_id"]) if body["head_id"] else None
        if head and not employees.find_one({"_id": head}):
            raise ApiError("Department head does not exist", 400)
        updates["head_id"] = head
    if updates:
        departments.update_one({"_id": dept["_id"]}, {"$set": updates})
    audit("DEPARTMENT_UPDATED", "department", dept["_id"], {"fields": list(updates)})
    return {"department": serialize(departments.find_one({"_id": dept["_id"]})),
            "message": "Department updated"}


@bp.delete("/departments/<dept_id>")
@roles_required("admin")
def delete_department(dept_id):
    dept = departments.find_one({"_id": oid(dept_id)})
    if not dept:
        raise ApiError("Department not found", 404)
    members = employees.count_documents({"department_id": dept["_id"], "status": "active"})
    children = departments.count_documents({"parent_id": dept["_id"]})
    if members or children:
        raise ApiError(f"Cannot delete — {members} active members and {children} "
                       f"sub-departments still attached", 409)
    departments.delete_one({"_id": dept["_id"]})
    audit("DEPARTMENT_DELETED", "department", dept["_id"], {"name": dept.get("name")})
    return {"ok": True, "message": "Department deleted"}
