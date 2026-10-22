"""
core.py — Central configuration, MongoDB layer, security primitives & shared helpers.

This module is the backbone of the Employee Management Portal:
  * MongoDB connection + index management (unique keys = data-integrity constraints)
  * JWT issuing / verification (HS256, expiring tokens)
  * bcrypt password hashing
  * Role-Based Access Control decorators  (Admin / HR / Manager / Employee)
  * ACID multi-document transactions with graceful capability probing
    (the MongoDB equivalent of "row-level locking" is optimistic concurrency
     control via version fields + atomic conditional updates — both live here)
  * Idempotency-key engine that makes leave/payroll submissions replay-safe
  * Audit-trail writer used by every sensitive action
"""
import os
import re
import json
import hashlib
import secrets
from functools import wraps
from datetime import datetime, timedelta, timezone, date

import bcrypt
import jwt
from dotenv import load_dotenv
from bson import ObjectId
from bson.errors import InvalidId
from pymongo import MongoClient, ASCENDING, DESCENDING
from pymongo.errors import DuplicateKeyError, PyMongoError, OperationFailure, ConfigurationError
from flask import g, request

load_dotenv()

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://127.0.0.1:27017")
DB_NAME = os.getenv("DB_NAME", "emp_portal")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-secret-change-me")
JWT_EXPIRES_HOURS = int(os.getenv("JWT_EXPIRES_HOURS", "24"))
AUTO_SEED = os.getenv("AUTO_SEED", "true").lower() == "true"
APP_NAME = "Zentra HR"

# The app operates on a single business timezone so attendance / payroll
# calendars stay consistent regardless of where the serverless instance runs.
IST = timezone(timedelta(hours=5, minutes=30))
WORK_START = (9, 30)          # 09:30 IST — check-ins after this are "late"

ROLES = ("admin", "hr", "manager", "employee")
LEAVE_TYPES = ("annual", "sick", "casual")
DEFAULT_BALANCES = {"annual": 20, "sick": 12, "casual": 8}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_ist() -> datetime:
    return datetime.now(IST)


def today_ist() -> str:
    """Business date (YYYY-MM-DD) in IST."""
    return now_ist().strftime("%Y-%m-%d")


def ist_minutes() -> int:
    """Minutes since midnight in IST — used for the late check-in rule."""
    n = now_ist()
    return n.hour * 60 + n.minute


# --------------------------------------------------------------------------- #
# MongoDB — one client per process, reused across warm serverless invocations
# --------------------------------------------------------------------------- #
client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=8000, maxPoolSize=25)
db = client[DB_NAME]

users = db.users
employees = db.employees
departments = db.departments
attendance = db.attendance
leave_requests = db.leave_requests
payroll_runs = db.payroll_runs
payslips = db.payslips
audit_logs = db.audit_logs
idempotency_keys = db.idempotency_keys
app_meta = db.app_meta


def ensure_indexes():
    """Create all indexes (idempotent). Unique indexes act as the schema-level
    integrity constraints referenced in the system design."""
    users.create_index([("email", ASCENDING)], unique=True)

    employees.create_index([("emp_code", ASCENDING)], unique=True)
    employees.create_index([("email", ASCENDING)], unique=True)
    employees.create_index([("department_id", ASCENDING)])
    employees.create_index([("manager_id", ASCENDING)])
    employees.create_index([("status", ASCENDING)])

    departments.create_index([("code", ASCENDING)], unique=True)

    # One attendance record per employee per day — prevents double check-ins
    attendance.create_index([("employee_id", ASCENDING), ("date", ASCENDING)], unique=True)
    attendance.create_index([("date", ASCENDING)])

    leave_requests.create_index([("employee_id", ASCENDING), ("status", ASCENDING)])
    leave_requests.create_index([("status", ASCENDING)])
    leave_requests.create_index([("created_at", ASCENDING)])

    # Idempotency engine: unique key + 30-day TTL housekeeping
    idempotency_keys.create_index([("key", ASCENDING)], unique=True)
    idempotency_keys.create_index([("created_at", ASCENDING)], expireAfterSeconds=30 * 86400)

    # Only one payroll run per (year, month) — enforced at the database level
    payroll_runs.create_index([("year", ASCENDING), ("month", ASCENDING)], unique=True)

    payslips.create_index([("run_id", ASCENDING)])
    payslips.create_index([("employee_id", ASCENDING)])

    audit_logs.create_index([("created_at", ASCENDING)])
    audit_logs.create_index([("action", ASCENDING)])
    audit_logs.create_index([("actor_id", ASCENDING)])

    app_meta.create_index([("key", ASCENDING)], unique=True)


# --------------------------------------------------------------------------- #
# Errors & serialization
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    """Business-level error with an HTTP status. Raised inside transactions to
    trigger an automatic abort / rollback."""
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def serialize(doc):
    """Recursively convert BSON → JSON-safe values. ``_id`` becomes ``id``."""
    if isinstance(doc, (list, tuple)):
        return [serialize(d) for d in doc]
    if isinstance(doc, dict):
        out = {}
        for k, v in doc.items():
            key = "id" if k == "_id" else k
            out[key] = serialize(v)
        return out
    if isinstance(doc, ObjectId):
        return str(doc)
    if isinstance(doc, datetime):
        return doc.isoformat()
    if isinstance(doc, date):
        return doc.isoformat()
    return doc


def oid(value):
    """Parse a hex string into ObjectId with a clean 400 on failure."""
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise ApiError("Invalid identifier supplied", 400)


def clean(s, max_len=200):
    return str(s or "").strip()[:max_len]


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------- #
# Security — bcrypt + JWT + RBAC
# --------------------------------------------------------------------------- #
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_token(user: dict) -> str:
    payload = {
        "sub": str(user["_id"]),
        "role": user["role"],
        "email": user["email"],
        "emp_id": str(user["employee_id"]) if user.get("employee_id") else None,
        "iat": now_utc(),
        "exp": now_utc() + timedelta(hours=JWT_EXPIRES_HOURS),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])


def token_required(fn):
    """Reject unauthenticated / disabled accounts; hydrate ``g.user``."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise ApiError("Missing or malformed Authorization header", 401)
        try:
            payload = decode_token(header[7:].strip())
        except jwt.ExpiredSignatureError:
            raise ApiError("Session expired — please log in again", 401)
        except jwt.InvalidTokenError:
            raise ApiError("Invalid authentication token", 401)
        try:
            account = users.find_one({"_id": ObjectId(payload["sub"])})
        except Exception:
            account = None
        if not account or account.get("status") != "active":
            raise ApiError("Account not found or disabled", 403)
        g.user = {
            "id": str(account["_id"]),
            "role": account["role"],
            "email": account["email"],
            "name": account.get("name", ""),
            "emp_id": str(account["employee_id"]) if account.get("employee_id") else None,
        }
        return fn(*args, **kwargs)
    return wrapper


def roles_required(*roles):
    """Role-Based Access Control gate — the endpoint only executes when the
    caller's role is one of ``roles``."""
    def decorator(fn):
        @wraps(fn)
        @token_required
        def wrapper(*args, **kwargs):
            if g.user["role"] not in roles:
                raise ApiError(f"Forbidden — requires one of roles: {', '.join(roles)}", 403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def is_admin_hr() -> bool:
    return getattr(g, "user", None) is not None and g.user["role"] in ("admin", "hr")


def current_scope_ids():
    """Employee ObjectIds the caller may see, based on role:
      employee → self only;  manager → self + direct reports;  admin/hr → None (= all)
    """
    role = g.user["role"]
    if role in ("admin", "hr"):
        return None
    me = oid(g.user["emp_id"])
    if role == "manager":
        reports = [d["_id"] for d in employees.find({"manager_id": me}, {"_id": 1})]
        return set(reports) | {me}
    return {me}


# --------------------------------------------------------------------------- #
# ACID transactions with capability probing
# --------------------------------------------------------------------------- #
_tx_supported = None  # None = unknown, True/False after probe


def _tx_unsupported(err) -> bool:
    msg = str(err).lower()
    return "transaction" in msg and any(
        k in msg for k in ("not supported", "only allowed", "numbers", "requires")
    )


def run_transaction(fn):
    """Run ``fn(session)`` inside a multi-document ACID transaction when the
    deployment supports them (Atlas replica sets do). Any exception — including
    :class:`ApiError` — aborts and rolls back every write in the block.
    Transient write conflicts (two transactions racing on the same document)
    are retried up to 3 times — the standard MongoDB pattern — and surface as
    a clean HTTP 409 if contention persists. On deployments without
    transaction support the function degrades to sequential execution
    (callers still guard every write with atomic conditional updates, so
    correctness never depends on the transaction)."""
    global _tx_supported
    if _tx_supported is False:
        return fn(None)

    last_exc = None
    for attempt in range(3):
        try:
            with client.start_session() as session:
                try:
                    with session.start_transaction():
                        result = fn(session)
                    return result
                except PyMongoError as exc:
                    if _tx_unsupported(exc):
                        _tx_supported = False
                        return fn(None)
                    raise
        except (ConfigurationError, OperationFailure) as exc:
            if _tx_unsupported(exc):
                _tx_supported = False
                return fn(None)
            if getattr(exc, "code", None) == 112 or "WriteConflict" in str(exc) \
                    or "TransientTransactionError" in getattr(exc, "_labels", []) \
                    or "TransientTransactionError" in str(exc):
                last_exc = exc
                continue          # transient contention — retry the whole block
            raise
    raise ApiError("High contention on this resource — please retry in a moment.", 409)


# --------------------------------------------------------------------------- #
# Idempotency engine
# --------------------------------------------------------------------------- #
def _request_fingerprint() -> str:
    body = request.get_json(silent=True) or {}
    return hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:20]


def with_idempotency(scope: str, executor):
    """Replay-safe execution for state-changing submissions.

    The client supplies an ``Idempotency-Key`` header (a UUID generated per
    logical submission). The first request executes ``executor(session)`` and
    caches the response; duplicate submissions with the same key return the
    cached response instead of performing the work twice.
    """
    raw_key = (request.headers.get("Idempotency-Key") or "").strip()
    user_id = g.user["id"]
    if not raw_key:
        raw_key = "auto-" + hashlib.sha256(
            f"{scope}|{user_id}|{_request_fingerprint()}|{today_ist()}".encode()
        ).hexdigest()[:24]
    key = f"{scope}:{user_id}:{raw_key[:120]}"

    try:
        idempotency_keys.insert_one({
            "key": key,
            "scope": scope,
            "user_id": user_id,
            "fingerprint": _request_fingerprint(),
            "response": None,
            "created_at": now_utc(),
        })
    except DuplicateKeyError:
        prev = idempotency_keys.find_one({"key": key})
        if prev and prev.get("response"):
            stored = prev["response"]
            return {**stored.get("payload", {}), "replayed": True}, stored.get("status", 200)
        raise ApiError("This request is already being processed — please retry shortly.", 409)

    try:
        payload, status = run_transaction(lambda s: executor(s))
        idempotency_keys.update_one({"key": key},
                                    {"$set": {"response": {"status": status, "payload": payload}}})
        return payload, status
    except Exception:
        # Release the key so a corrected retry is possible
        idempotency_keys.delete_one({"key": key})
        raise


# --------------------------------------------------------------------------- #
# Audit trail
# --------------------------------------------------------------------------- #
def has_request() -> bool:
    try:
        from flask import has_request_context
        return has_request_context()
    except Exception:
        return False


def audit(action: str, entity_type: str, entity_id=None, details: dict | None = None,
          session=None, actor: dict | None = None):
    """Record an immutable audit-log entry for a sensitive action.
    Audit writes must never break the main flow — failures are swallowed."""
    try:
        u = actor or getattr(g, "user", None)
        audit_logs.insert_one({
            "actor_id": u.get("id") if u else None,
            "actor_name": u.get("name") or (u.get("email") if u else "system"),
            "actor_role": u.get("role") if u else "system",
            "action": action,
            "entity_type": entity_type,
            "entity_id": str(entity_id) if entity_id else None,
            "details": details or {},
            "ip": request.remote_addr if has_request() else None,
            "created_at": now_utc(),
        }, session=session)
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# Shared aggregation helpers
# --------------------------------------------------------------------------- #
EMPLOYEE_LOOKUP = [
    {"$lookup": {"from": "departments", "localField": "department_id",
                 "foreignField": "_id", "as": "department",
                 "pipeline": [{"$project": {"name": 1, "code": 1}}]}},
    {"$set": {"department_name": {"$arrayElemAt": ["$department.name", 0]},
              "department_code": {"$arrayElemAt": ["$department.code", 0]}}},
    {"$lookup": {"from": "employees", "localField": "manager_id",
                 "foreignField": "_id", "as": "manager",
                 "pipeline": [{"$project": {"first_name": 1, "last_name": 1}}]}},
    {"$set": {"manager_name": {"$cond": [
        {"$gt": [{"$size": "$manager"}, 0]},
        {"$trim": {"input": {"$concat": [
            {"$arrayElemAt": ["$manager.first_name", 0]}, " ",
            {"$arrayElemAt": ["$manager.last_name", 0]}]}}},
        None]}}},
    {"$unset": ["department", "manager"]},
]
