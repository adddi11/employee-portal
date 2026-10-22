"""
index.py — Flask application entry point.

This single file works in BOTH worlds:
  * Local development:  ``python api/index.py``  → serves API + static frontend
  * Vercel:            exported as ``app`` — Vercel's Python runtime wraps it
                       as a serverless function; ``public/`` is served by the
                       Vercel edge (see vercel.json rewrites for /api/*).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, jsonify, request, send_from_directory
from pymongo.errors import PyMongoError

from core import ApiError, ensure_indexes
from flask_cors import CORS

import routes_auth
import routes_people
import routes_time
import routes_pay
import routes_misc

app = Flask(__name__, static_folder=None)
app.config["JSON_SORT_KEYS"] = False
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024

CORS(app, resources={r"/api/*": {"origins": "*"}},
     allow_headers=["Content-Type", "Authorization", "Idempotency-Key"])

# Index creation must NEVER crash the serverless cold start: if MongoDB is
# unreachable (e.g. MONGODB_URI missing on a fresh Vercel deploy) the app still
# boots and every request surfaces a clean, actionable JSON error instead of
# an empty 500 that browsers report as "Unexpected end of JSON input".
try:
    ensure_indexes()
except Exception as exc:                                    # pragma: no cover
    print(f"[startup] MongoDB unavailable — {exc}", file=sys.stderr)

app.register_blueprint(routes_auth.bp)
app.register_blueprint(routes_people.bp)
app.register_blueprint(routes_time.bp)
app.register_blueprint(routes_pay.bp)
app.register_blueprint(routes_misc.bp)

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")


# --------------------------------------------------------------------------- #
# Static frontend (used for local dev; on Vercel the platform serves public/)
# --------------------------------------------------------------------------- #
@app.route("/")
def root():
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        return jsonify({"error": "Endpoint not found"}), 404
    target = os.path.join(PUBLIC_DIR, path)
    if os.path.isfile(target):
        return send_from_directory(PUBLIC_DIR, path)
    return send_from_directory(PUBLIC_DIR, "index.html")


# --------------------------------------------------------------------------- #
# Uniform JSON error handling
# --------------------------------------------------------------------------- #
@app.errorhandler(ApiError)
def handle_api_error(err):
    return jsonify({"error": err.message}), err.status


@app.errorhandler(404)
def handle_404(_):
    if request.path.startswith("/api/"):
        return jsonify({"error": "Endpoint not found"}), 404
    return send_from_directory(PUBLIC_DIR, "index.html")


@app.errorhandler(405)
def handle_405(_):
    return jsonify({"error": "Method not allowed for this endpoint"}), 405


@app.errorhandler(PyMongoError)
def handle_db_error(err):
    """Database unreachable / failed operation → clean 503 with guidance.
    Without this, a crashed serverless invocation returns an EMPTY body and
    the frontend dies with 'Unexpected end of JSON input'."""
    import traceback
    traceback.print_exc()
    return jsonify({"error": "Database unavailable — verify MONGODB_URI (Atlas: allow network access 0.0.0.0/0) and that the cluster is running"}), 503


@app.errorhandler(Exception)
def handle_unexpected(err):
    import traceback
    traceback.print_exc()
    return jsonify({"error": "Internal server error — check server logs"}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", "3000"))
    print(f"  {os.getenv('APP_NAME', 'Zentra HR')} API running on http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
