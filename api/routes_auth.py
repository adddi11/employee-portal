"""
routes_auth.py — Authentication endpoints: login, session profile, password change.

Security features:
  * bcrypt-verified credentials (never stores plaintext)
  * JWT (HS256, 24h expiry) issued on success
  * Simple in-memory brute-force throttling per IP
  * Every login / password change is written to the audit trail
"""
import time
from flask import Blueprint, request, g

from core import (ApiError, audit, clean, create_token, employees, hash_password,
                  now_utc, oid, serialize, users, verify_password, EMAIL_RE,
                  token_required)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

# naive per-IP throttle: 12 attempts / 5 min (per warm instance)
_login_attempts: dict = {}
MAX_ATTEMPTS, WINDOW = 12, 300


def _throttled(ip: str) -> tuple[bool, int]:
    now = time.time()
    hits = [t for t in _login_attempts.get(ip, []) if now - t < WINDOW]
    _login_attempts[ip] = hits
    return (len(hits) >= MAX_ATTEMPTS, max(0, int(WINDOW - (now - hits[0]))) if hits else 0)


@bp.post("/login")
def login():
    from seed import ensure_seeded          # lazy import avoids a circular import
    ensure_seeded()

    ip = request.remote_addr or "?"
    blocked, retry = _throttled(ip)
    if blocked:
        raise ApiError(f"Too many login attempts — retry in {retry}s", 429)

    body = request.get_json(silent=True) or {}
    email = clean(body.get("email"), 120).lower()
    password = str(body.get("password") or "")
    if not email or not password:
        raise ApiError("Email and password are required", 400)

    account = users.find_one({"email": email})
    _login_attempts.setdefault(ip, []).append(time.time())

    if not account or not verify_password(password, account.get("password_hash", "")):
        audit("LOGIN_FAILED", "user", details={"email": email})
        raise ApiError("Invalid email or password", 401)
    if account.get("status") != "active":
        raise ApiError("This account has been disabled — contact your administrator", 403)

    users.update_one({"_id": account["_id"]}, {"$set": {"last_login": now_utc()}})
    token = create_token(account)
    g.user = {"id": str(account["_id"]), "role": account["role"], "email": account["email"],
              "name": account.get("name", ""),
              "emp_id": str(account["employee_id"]) if account.get("employee_id") else None}
    audit("LOGIN", "user", account["_id"], {"email": email})

    employee = None
    if account.get("employee_id"):
        employee = serialize(employees.find_one({"_id": account["employee_id"]},
                                                {"salary": 0, "password_hash": 0}))
    return {
        "token": token,
        "user": {
            "id": str(account["_id"]),
            "name": account.get("name", email.split("@")[0].title()),
            "email": account["email"],
            "role": account["role"],
            "employee_id": str(account["employee_id"]) if account.get("employee_id") else None,
        },
        "employee": employee,
    }


@bp.get("/me")
@token_required
def me():
    account = users.find_one({"_id": oid(g.user["id"])}, {"password_hash": 0})
    employee = None
    if account and account.get("employee_id"):
        employee = serialize(employees.find_one({"_id": account["employee_id"]},
                                                {"salary": 0}))
    return {"user": serialize({**account, "password_hash": None} if account else {}),
            "employee": employee}


@bp.post("/change-password")
@token_required
def change_password():
    body = request.get_json(silent=True) or {}
    old_pw, new_pw = str(body.get("current_password") or ""), str(body.get("new_password") or "")
    if len(new_pw) < 8:
        raise ApiError("New password must be at least 8 characters", 400)
    account = users.find_one({"_id": oid(g.user["id"])})
    if not account or not verify_password(old_pw, account.get("password_hash", "")):
        raise ApiError("Current password is incorrect", 400)
    users.update_one({"_id": account["_id"]},
                     {"$set": {"password_hash": hash_password(new_pw),
                               "updated_at": now_utc()}})
    audit("PASSWORD_CHANGED", "user", account["_id"])
    return {"ok": True, "message": "Password updated successfully"}
