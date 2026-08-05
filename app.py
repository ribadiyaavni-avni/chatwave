"""
ChatWave — a lightweight one-to-one PWA chat app built with Flask + MySQL.

Features
--------
- Direct signup (no connect codes, no admin-generated codes)
- Secure password hashing (Werkzeug)
- Session-based login, auto-login right after signup
- One-to-one chat with polling-based realtime updates
- Profile photos (uploaded to static/uploads)
- Online/offline presence via Socket.IO connections + last_seen timestamps
- WhatsApp-style REAL-TIME calling:
    * WebRTC peer-to-peer audio/video (media never touches the server)
    * Flask-SocketIO used ONLY for signaling (SDP offer/answer + ICE)
    * STUN by default, TURN configurable via environment variables
    * Call history persisted in MySQL (`calls` table) and mirrored into the
      chat as WhatsApp-style status messages (missed / declined / duration)
- MySQL database (XAMPP-compatible) created automatically on first run
  using mysql-connector-python

Configuration (XAMPP defaults, overridable via environment variables)
---------------------------------------------------------------------
    MYSQL_HOST      default: localhost
    MYSQL_PORT      default: 3306
    MYSQL_USER      default: root
    MYSQL_PASSWORD  default: ""        (XAMPP ships root with no password)
    MYSQL_DB        default: chatwave

    STUN_URLS       default: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
    TURN_URLS       default: ""   e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349"
    TURN_USERNAME   default: ""
    TURN_CREDENTIAL default: ""

Run:  python app.py   →  http://localhost:5000
"""

import os
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from functools import wraps

import mysql.connector
from mysql.connector import Error as MySQLError
from flask import (
    Flask, render_template, request, redirect, url_for,
    session, jsonify, g, abort, send_from_directory
)
from flask_socketio import SocketIO, join_room, emit
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "static", "uploads")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}
ONLINE_WINDOW_SECONDS = 40  # fallback: user counts as online if seen within this window

# ---- XAMPP MySQL configuration -------------------------------------------
DB_CONFIG = {
    "host": os.environ.get("MYSQL_HOST", "localhost"),
    "port": int(os.environ.get("MYSQL_PORT", "3306")),
    "user": os.environ.get("MYSQL_USER", "root"),
    "password": os.environ.get("MYSQL_PASSWORD", ""),  # XAMPP default: empty
    "charset": "utf8mb4",
    "collation": "utf8mb4_general_ci",
}
DB_NAME = os.environ.get("MYSQL_DB", "chatwave")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "change-this-in-production-" + uuid.uuid4().hex)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 5 MB upload cap
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Socket.IO: signaling only. threading mode = zero extra server dependencies,
# works with the plain Flask dev server (simple-websocket provides WebSocket).
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")


# --------------------------------------------------------------------------
# Database helpers
# --------------------------------------------------------------------------

def get_db():
    """One MySQL connection per request, stored on Flask's `g`."""
    if "db" not in g:
        g.db = mysql.connector.connect(database=DB_NAME, **DB_CONFIG)
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def query(sql, args=(), one=False):
    """Run a SELECT and return dict rows (or a single dict / None)."""
    cur = get_db().cursor(dictionary=True)
    cur.execute(sql, args)
    rows = cur.fetchall()
    cur.close()
    return (rows[0] if rows else None) if one else rows


def execute(sql, args=()):
    """Run an INSERT/UPDATE/DELETE, commit, and return lastrowid."""
    db = get_db()
    cur = db.cursor()
    cur.execute(sql, args)
    db.commit()
    last_id = cur.lastrowid
    cur.close()
    return last_id


# ---- standalone DB access for Socket.IO handlers --------------------------
# Socket.IO events run outside a Flask request, so Flask's `g` connection
# isn't available there. These helpers open a short-lived connection instead.

def sio_query(sql, args=(), one=False):
    conn = mysql.connector.connect(database=DB_NAME, **DB_CONFIG)
    cur = conn.cursor(dictionary=True)
    cur.execute(sql, args)
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return (rows[0] if rows else None) if one else rows


def sio_execute(sql, args=()):
    conn = mysql.connector.connect(database=DB_NAME, **DB_CONFIG)
    cur = conn.cursor()
    cur.execute(sql, args)
    conn.commit()
    last_id = cur.lastrowid
    cur.close()
    conn.close()
    return last_id


def init_db():
    """Create the database and tables automatically if they don't exist."""
    try:
        # Connect WITHOUT selecting a database so we can create it first
        conn = mysql.connector.connect(**DB_CONFIG)
    except MySQLError as err:
        print(
            "\n[ChatWave] Could not connect to MySQL.\n"
            f"           {err}\n\n"
            "           Is XAMPP running? Open the XAMPP Control Panel and\n"
            "           press Start next to MySQL, then run this app again.\n"
            "           (Expected server at "
            f"{DB_CONFIG['host']}:{DB_CONFIG['port']}, user "
            f"'{DB_CONFIG['user']}'.)\n",
            file=sys.stderr,
        )
        raise SystemExit(1)

    cur = conn.cursor()
    cur.execute(
        f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
        "CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
    )
    cur.execute(f"USE `{DB_NAME}`")

    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id            INT AUTO_INCREMENT PRIMARY KEY,
            username      VARCHAR(20)  NOT NULL UNIQUE,
            display_name  VARCHAR(40)  NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            photo         VARCHAR(120) DEFAULT NULL,
            about         VARCHAR(140) DEFAULT 'Hey there! I am using ChatWave.',
            created_at    DATETIME     NOT NULL,
            last_seen     DATETIME     DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS messages (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            sender_id   INT  NOT NULL,
            receiver_id INT  NOT NULL,
            body        TEXT NOT NULL,
            created_at  DATETIME NOT NULL,
            seen        TINYINT(1) NOT NULL DEFAULT 0,
            CONSTRAINT fk_messages_sender
                FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE,
            CONSTRAINT fk_messages_receiver
                FOREIGN KEY (receiver_id) REFERENCES users (id) ON DELETE CASCADE,
            INDEX idx_messages_pair (sender_id, receiver_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """
    )
    # NEW: WebRTC call history (does not touch users/messages)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS calls (
            id               INT AUTO_INCREMENT PRIMARY KEY,
            caller_id        INT NOT NULL,
            callee_id        INT NOT NULL,
            kind             ENUM('audio','video') NOT NULL DEFAULT 'audio',
            status           ENUM('ringing','active','completed','missed',
                                  'rejected','cancelled','failed') NOT NULL DEFAULT 'ringing',
            created_at       DATETIME NOT NULL,
            started_at       DATETIME DEFAULT NULL,
            ended_at         DATETIME DEFAULT NULL,
            duration_seconds INT NOT NULL DEFAULT 0,
            CONSTRAINT fk_calls_caller
                FOREIGN KEY (caller_id) REFERENCES users (id) ON DELETE CASCADE,
            CONSTRAINT fk_calls_callee
                FOREIGN KEY (callee_id) REFERENCES users (id) ON DELETE CASCADE,
            INDEX idx_calls_caller (caller_id, id),
            INDEX idx_calls_callee (callee_id, id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        """
    )
    conn.commit()
    cur.close()
    conn.close()


init_db()


# --------------------------------------------------------------------------
# Utilities
# --------------------------------------------------------------------------

def utcnow():
    """Naive UTC datetime — matches MySQL DATETIME (no timezone stored)."""
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def iso(dt):
    """Serialize a DB datetime as ISO-8601 UTC for the frontend."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api/"):
                return jsonify({"error": "unauthorized"}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def current_user():
    if "user_id" not in session:
        return None
    return query("SELECT * FROM users WHERE id = %s", (session["user_id"],), one=True)


def is_online(user_id, last_seen):
    """Online = has a live Socket.IO connection, or seen very recently."""
    if user_id in USER_SIDS and USER_SIDS[user_id]:
        return True
    if not last_seen:
        return False
    return (utcnow() - last_seen).total_seconds() < ONLINE_WINDOW_SECONDS


def touch_presence(user_id):
    execute("UPDATE users SET last_seen = %s WHERE id = %s", (utcnow(), user_id))


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.]{3,20}$")


# --------------------------------------------------------------------------
# Auth routes
# --------------------------------------------------------------------------

@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("home"))
    return redirect(url_for("login"))


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if "user_id" in session:
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        display_name = request.form.get("display_name", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")

        if not USERNAME_RE.match(username):
            error = "Username must be 3-20 characters: letters, numbers, dots, or underscores."
        elif not display_name or len(display_name) > 40:
            error = "Please enter a display name (up to 40 characters)."
        elif len(password) < 6:
            error = "Password must be at least 6 characters."
        elif password != confirm:
            error = "Passwords do not match."
        else:
            # utf8mb4_general_ci collation makes this check case-insensitive
            exists = query("SELECT id FROM users WHERE username = %s", (username,), one=True)
            if exists:
                error = "That username is already taken."
            else:
                new_id = execute(
                    "INSERT INTO users (username, display_name, password_hash, created_at, last_seen) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (username, display_name,
                     generate_password_hash(password), utcnow(), utcnow()),
                )
                # Direct login after signup
                session.clear()
                session["user_id"] = new_id
                session.permanent = True
                return redirect(url_for("home"))

    return render_template("signup.html", error=error)


@app.route("/login", methods=["GET", "POST"])
def login():
    if "user_id" in session:
        return redirect(url_for("home"))

    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = query("SELECT * FROM users WHERE username = %s", (username,), one=True)
        if user is None or not check_password_hash(user["password_hash"], password):
            error = "Incorrect username or password."
        else:
            session.clear()
            session["user_id"] = user["id"]
            session.permanent = True
            touch_presence(user["id"])
            return redirect(url_for("home"))

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    # Mark the user as offline immediately by clearing last_seen
    if "user_id" in session:
        execute("UPDATE users SET last_seen = NULL WHERE id = %s", (session["user_id"],))
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------

@app.route("/home")
@login_required
def home():
    me = current_user()
    touch_presence(me["id"])
    return render_template("home.html", me=me)


@app.route("/chat/<int:user_id>")
@login_required
def chat(user_id):
    me = current_user()
    if user_id == me["id"]:
        return redirect(url_for("home"))
    other = query("SELECT * FROM users WHERE id = %s", (user_id,), one=True)
    if other is None:
        abort(404)
    touch_presence(me["id"])
    return render_template("chat.html", me=me, other=other)


@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    me = current_user()
    saved = False
    error = None

    if request.method == "POST":
        display_name = request.form.get("display_name", "").strip()
        about = request.form.get("about", "").strip()

        if not display_name or len(display_name) > 40:
            error = "Display name is required (up to 40 characters)."
        elif len(about) > 140:
            error = "About can be at most 140 characters."
        else:
            photo_name = me["photo"]
            file = request.files.get("photo")
            if file and file.filename:
                if not allowed_file(file.filename):
                    error = "Photo must be a PNG, JPG, GIF, or WEBP image."
                else:
                    ext = file.filename.rsplit(".", 1)[1].lower()
                    photo_name = secure_filename(f"u{me['id']}_{uuid.uuid4().hex[:10]}.{ext}")
                    file.save(os.path.join(UPLOAD_FOLDER, photo_name))
                    # Clean up the previous photo
                    if me["photo"]:
                        old = os.path.join(UPLOAD_FOLDER, me["photo"])
                        if os.path.exists(old):
                            os.remove(old)
            if not error:
                execute(
                    "UPDATE users SET display_name = %s, about = %s, photo = %s WHERE id = %s",
                    (display_name, about or "Hey there! I am using ChatWave.", photo_name, me["id"]),
                )
                saved = True
                me = current_user()

    return render_template("profile.html", me=me, saved=saved, error=error)


# --------------------------------------------------------------------------
# JSON API
# --------------------------------------------------------------------------

def serialize_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "about": row["about"],
        "photo": url_for("static", filename=f"uploads/{row['photo']}") if row["photo"] else None,
        "online": is_online(row["id"], row["last_seen"]),
    }


@app.route("/api/heartbeat", methods=["POST"])
@login_required
def heartbeat():
    touch_presence(session["user_id"])
    return jsonify({"ok": True})


@app.route("/api/users")
@login_required
def api_users():
    """All other users, with their last message exchanged with me and unread count."""
    me_id = session["user_id"]
    users = query(
        "SELECT * FROM users WHERE id != %s ORDER BY display_name", (me_id,)
    )

    result = []
    for u in users:
        last = query(
            "SELECT body, sender_id, created_at FROM messages "
            "WHERE (sender_id = %s AND receiver_id = %s) OR (sender_id = %s AND receiver_id = %s) "
            "ORDER BY id DESC LIMIT 1",
            (me_id, u["id"], u["id"], me_id),
            one=True,
        )
        unread = query(
            "SELECT COUNT(*) AS c FROM messages "
            "WHERE sender_id = %s AND receiver_id = %s AND seen = 0",
            (u["id"], me_id),
            one=True,
        )["c"]

        item = serialize_user(u)
        item["last_message"] = (
            {
                "body": last["body"],
                "mine": last["sender_id"] == me_id,
                "created_at": iso(last["created_at"]),
            }
            if last else None
        )
        item["unread"] = unread
        result.append(item)

    # Chats with recent messages first, then alphabetical
    result.sort(
        key=lambda x: (x["last_message"]["created_at"] if x["last_message"] else ""),
        reverse=True,
    )
    return jsonify({"users": result})


@app.route("/api/messages/<int:other_id>", methods=["GET"])
@login_required
def get_messages(other_id):
    me_id = session["user_id"]
    other = query("SELECT * FROM users WHERE id = %s", (other_id,), one=True)
    if other is None:
        return jsonify({"error": "user not found"}), 404

    after = request.args.get("after", 0, type=int)
    rows = query(
        "SELECT * FROM messages "
        "WHERE id > %s AND ((sender_id = %s AND receiver_id = %s) OR (sender_id = %s AND receiver_id = %s)) "
        "ORDER BY id ASC LIMIT 200",
        (after, me_id, other_id, other_id, me_id),
    )

    # Mark incoming messages as seen
    execute(
        "UPDATE messages SET seen = 1 WHERE sender_id = %s AND receiver_id = %s AND seen = 0",
        (other_id, me_id),
    )

    return jsonify({
        "messages": [
            {
                "id": m["id"],
                "body": m["body"],
                "mine": m["sender_id"] == me_id,
                "created_at": iso(m["created_at"]),
                "seen": bool(m["seen"]),
            }
            for m in rows
        ],
        "other": serialize_user(other),
    })


@app.route("/api/messages/<int:other_id>", methods=["POST"])
@login_required
def send_message(other_id):
    me_id = session["user_id"]
    other = query("SELECT id FROM users WHERE id = %s", (other_id,), one=True)
    if other is None:
        return jsonify({"error": "user not found"}), 404

    body = (request.get_json(silent=True) or {}).get("body", "").strip()
    if not body:
        return jsonify({"error": "message is empty"}), 400
    if len(body) > 2000:
        return jsonify({"error": "message is too long (max 2000 characters)"}), 400

    now = utcnow()
    new_id = execute(
        "INSERT INTO messages (sender_id, receiver_id, body, created_at) VALUES (%s, %s, %s, %s)",
        (me_id, other_id, body, now),
    )
    touch_presence(me_id)
    return jsonify({"ok": True, "id": new_id, "created_at": iso(now)})


@app.route("/api/calls")
@login_required
def api_calls():
    """Call history for the signed-in user (newest first)."""
    me_id = session["user_id"]
    rows = query(
        "SELECT c.*, "
        "  cu.display_name AS caller_name, cu.photo AS caller_photo, cu.username AS caller_username, "
        "  ce.display_name AS callee_name, ce.photo AS callee_photo, ce.username AS callee_username "
        "FROM calls c "
        "JOIN users cu ON cu.id = c.caller_id "
        "JOIN users ce ON ce.id = c.callee_id "
        "WHERE c.caller_id = %s OR c.callee_id = %s "
        "ORDER BY c.id DESC LIMIT 100",
        (me_id, me_id),
    )
    out = []
    for r in rows:
        outgoing = r["caller_id"] == me_id
        other_name = r["callee_name"] if outgoing else r["caller_name"]
        other_photo = r["callee_photo"] if outgoing else r["caller_photo"]
        other_id = r["callee_id"] if outgoing else r["caller_id"]
        out.append({
            "id": r["id"],
            "other_id": other_id,
            "other_name": other_name,
            "other_photo": url_for("static", filename=f"uploads/{other_photo}") if other_photo else None,
            "outgoing": outgoing,
            "kind": r["kind"],
            "status": r["status"],
            "created_at": iso(r["created_at"]),
            "duration": r["duration_seconds"],
        })
    return jsonify({"calls": out})


@app.route("/api/rtc-config")
@login_required
def rtc_config():
    """ICE server configuration for RTCPeerConnection (STUN + optional TURN)."""
    stun_urls = [u.strip() for u in os.environ.get(
        "STUN_URLS",
        "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
    ).split(",") if u.strip()]
    ice_servers = [{"urls": stun_urls}]

    turn_urls = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
    if turn_urls:
        ice_servers.append({
            "urls": turn_urls,
            "username": os.environ.get("TURN_USERNAME", ""),
            "credential": os.environ.get("TURN_CREDENTIAL", ""),
        })
    return jsonify({"iceServers": ice_servers})


# --------------------------------------------------------------------------
# PWA files served from the root scope
# --------------------------------------------------------------------------

@app.route("/manifest.json")
def manifest():
    return send_from_directory(os.path.join(BASE_DIR, "static"), "manifest.json")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(os.path.join(BASE_DIR, "static"), "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/offline")
def offline():
    return render_template("offline.html")


# ==========================================================================
# Calls — WhatsApp-style WebRTC calling.
#
# Flask/Socket.IO is a SIGNALING SERVER ONLY:
#   * call lifecycle events  : call:start / accept / reject / cancel / end
#   * SDP exchange           : webrtc:offer / webrtc:answer  (relayed 1:1)
#   * ICE candidate exchange : webrtc:ice                    (relayed 1:1)
# Audio/video flows peer-to-peer between the two browsers via WebRTC,
# using STUN (and TURN, if configured) — the server never sees media.
#
# Call history is written to the `calls` MySQL table, and each finished
# call also drops a WhatsApp-style status line into the normal `messages`
# table so it appears inside the chat thread.
# ==========================================================================

_CALL_LOCK = threading.Lock()
LIVE_CALLS = {}   # call_id -> {"db_id", "caller", "callee", "kind", "status", "started", "timer"}
USER_SIDS = {}    # user_id -> set(socket session ids)
SID_USER = {}     # sid -> user_id

RING_TIMEOUT = 40  # seconds before an unanswered call becomes "missed"


def _fmt_duration(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _user_room(uid):
    return f"user:{uid}"


def _brief(uid):
    row = sio_query("SELECT * FROM users WHERE id = %s", (uid,), one=True)
    if not row:
        return {"id": uid, "display_name": "Unknown", "username": "", "photo": None, "about": ""}
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "about": row["about"],
        "photo": f"/static/uploads/{row['photo']}" if row["photo"] else None,
    }


def _call_of(uid):
    """The live (not ended) call this user is part of, if any."""
    for call_id, c in LIVE_CALLS.items():
        if uid in (c["caller"], c["callee"]) and c["status"] in ("ringing", "active"):
            return call_id, c
    return None, None


def _peer_of(call, uid):
    return call["callee"] if uid == call["caller"] else call["caller"]


def _log_chat_message(call, text):
    """Drop a WhatsApp-style call status line into the normal chat thread."""
    sio_execute(
        "INSERT INTO messages (sender_id, receiver_id, body, created_at) VALUES (%s, %s, %s, %s)",
        (call["caller"], call["callee"], text, utcnow()),
    )


def _finish_call(call_id, call, status):
    """Close a call: cancel ring timer, persist history, write chat line, notify."""
    if call["status"] == "ended":
        return
    call["status"] = "ended"
    timer = call.get("timer")
    if timer:
        timer.cancel()

    now = utcnow()
    duration = 0
    if status == "completed" and call["started"]:
        duration = int((now - call["started"]).total_seconds())

    sio_execute(
        "UPDATE calls SET status = %s, ended_at = %s, duration_seconds = %s WHERE id = %s",
        (status, now, duration, call["db_id"]),
    )

    icon = "📹" if call["kind"] == "video" else "📞"
    word = "video call" if call["kind"] == "video" else "voice call"
    if status == "completed":
        _log_chat_message(call, f"{icon} {word.capitalize()} · {_fmt_duration(duration)}")
    elif status == "rejected":
        _log_chat_message(call, f"{icon} {word.capitalize()} declined")
    else:  # missed / cancelled / failed
        _log_chat_message(call, f"{icon} Missed {word}")

    payload = {"call_id": call_id, "status": status, "duration": duration}
    socketio.emit("call:ended", payload, room=_user_room(call["caller"]))
    socketio.emit("call:ended", payload, room=_user_room(call["callee"]))
    LIVE_CALLS.pop(call_id, None)


def _ring_timeout(call_id):
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if call and call["status"] == "ringing":
            _finish_call(call_id, call, "missed")


# ---- Socket.IO lifecycle ---------------------------------------------------

@socketio.on("connect")
def sio_connect():
    uid = session.get("user_id")
    if not uid:
        return False  # reject unauthenticated sockets
    join_room(_user_room(uid))
    with _CALL_LOCK:
        USER_SIDS.setdefault(uid, set()).add(request.sid)
        SID_USER[request.sid] = uid
    sio_execute("UPDATE users SET last_seen = %s WHERE id = %s", (utcnow(), uid))
    # Presence broadcast: this user just came online
    emit("presence", {"user_id": uid, "online": True}, broadcast=True, include_self=False)

    # If the user reconnected mid-call (page refresh / network blip),
    # tell their client which call they belong to so the UI can recover.
    with _CALL_LOCK:
        call_id, call = _call_of(uid)
        if call_id:
            emit("call:rejoin", {
                "call_id": call_id,
                "kind": call["kind"],
                "status": call["status"],
                "caller": call["caller"],
                "callee": call["callee"],
                "peer": _brief(_peer_of(call, uid)),
                "started_at": iso(call["started"]),
            })


@socketio.on("disconnect")
def sio_disconnect():
    uid = SID_USER.pop(request.sid, None)
    if uid is None:
        return
    with _CALL_LOCK:
        sids = USER_SIDS.get(uid, set())
        sids.discard(request.sid)
        fully_offline = not sids
        if fully_offline:
            USER_SIDS.pop(uid, None)

        # If they were in a live call and have no other open tab, give them a
        # short grace window to reconnect (refresh / network drop) before the
        # call is torn down.
        call_id, call = _call_of(uid)

    if fully_offline:
        sio_execute("UPDATE users SET last_seen = %s WHERE id = %s", (utcnow(), uid))
        emit("presence", {"user_id": uid, "online": False}, broadcast=True, include_self=False)
        if call_id:
            socketio.emit("peer:connection", {"call_id": call_id, "state": "unstable"},
                          room=_user_room(_peer_of(call, uid)))
            threading.Timer(8.0, _drop_if_still_gone, args=(call_id, uid)).start()


def _drop_if_still_gone(call_id, uid):
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if not call or call["status"] == "ended":
            return
        if uid in USER_SIDS and USER_SIDS[uid]:
            return  # they came back
        if call["status"] == "ringing":
            _finish_call(call_id, call, "cancelled" if uid == call["caller"] else "missed")
        else:
            _finish_call(call_id, call, "completed" if call["started"] else "failed")


# ---- Call lifecycle signaling ---------------------------------------------

@socketio.on("call:start")
def sio_call_start(data):
    uid = session.get("user_id")
    if not uid:
        return
    data = data or {}
    kind = data.get("kind") if data.get("kind") in ("audio", "video") else "audio"
    try:
        target = int(data.get("to"))
    except (TypeError, ValueError):
        emit("call:error", {"error": "Invalid user."})
        return
    if target == uid or not sio_query("SELECT id FROM users WHERE id = %s", (target,), one=True):
        emit("call:error", {"error": "That user doesn't exist."})
        return

    with _CALL_LOCK:
        if _call_of(uid)[0]:
            emit("call:error", {"error": "You are already in a call."})
            return
        if _call_of(target)[0]:
            emit("call:error", {"error": "They are on another call right now.", "busy": True})
            return

        now = utcnow()
        db_id = sio_execute(
            "INSERT INTO calls (caller_id, callee_id, kind, status, created_at) "
            "VALUES (%s, %s, %s, 'ringing', %s)",
            (uid, target, kind, now),
        )
        call_id = uuid.uuid4().hex[:12]
        timer = threading.Timer(RING_TIMEOUT, _ring_timeout, args=(call_id,))
        LIVE_CALLS[call_id] = {
            "db_id": db_id, "caller": uid, "callee": target, "kind": kind,
            "status": "ringing", "started": None, "timer": timer,
        }
        timer.daemon = True
        timer.start()

    callee_online = target in USER_SIDS and USER_SIDS[target]
    emit("call:ringing", {
        "call_id": call_id, "kind": kind, "peer": _brief(target),
        "peer_online": bool(callee_online),
    })
    socketio.emit("call:incoming", {
        "call_id": call_id, "kind": kind, "from": _brief(uid),
    }, room=_user_room(target))


@socketio.on("call:accept")
def sio_call_accept(data):
    uid = session.get("user_id")
    call_id = (data or {}).get("call_id")
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if not call or call["callee"] != uid or call["status"] != "ringing":
            emit("call:error", {"error": "This call is no longer available.", "gone": True})
            return
        call["status"] = "active"
        call["started"] = utcnow()
        timer = call.get("timer")
        if timer:
            timer.cancel()
    sio_execute("UPDATE calls SET status = 'active', started_at = %s WHERE id = %s",
                (call["started"], call["db_id"]))
    payload = {"call_id": call_id, "started_at": iso(call["started"])}
    # Caller receives this and creates the SDP offer.
    socketio.emit("call:accepted", payload, room=_user_room(call["caller"]))
    emit("call:accepted", payload)


@socketio.on("call:reject")
def sio_call_reject(data):
    uid = session.get("user_id")
    call_id = (data or {}).get("call_id")
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if call and call["callee"] == uid and call["status"] == "ringing":
            _finish_call(call_id, call, "rejected")


@socketio.on("call:cancel")
def sio_call_cancel(data):
    uid = session.get("user_id")
    call_id = (data or {}).get("call_id")
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if call and call["caller"] == uid and call["status"] == "ringing":
            _finish_call(call_id, call, "cancelled")


@socketio.on("call:end")
def sio_call_end(data):
    uid = session.get("user_id")
    call_id = (data or {}).get("call_id")
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if not call or uid not in (call["caller"], call["callee"]):
            return
        if call["status"] == "active":
            _finish_call(call_id, call, "completed")
        elif call["status"] == "ringing":
            _finish_call(call_id, call, "cancelled" if uid == call["caller"] else "rejected")


# ---- WebRTC signaling relay (SDP + ICE) -----------------------------------

def _relay(event, data):
    """Relay an SDP/ICE payload to the other participant of the call."""
    uid = session.get("user_id")
    data = data or {}
    call_id = data.get("call_id")
    with _CALL_LOCK:
        call = LIVE_CALLS.get(call_id)
        if not call or uid not in (call["caller"], call["callee"]):
            return
        peer = _peer_of(call, uid)
    socketio.emit(event, data, room=_user_room(peer))


@socketio.on("webrtc:offer")
def sio_offer(data):
    _relay("webrtc:offer", data)       # {call_id, sdp}


@socketio.on("webrtc:answer")
def sio_answer(data):
    _relay("webrtc:answer", data)      # {call_id, sdp}


@socketio.on("webrtc:ice")
def sio_ice(data):
    _relay("webrtc:ice", data)         # {call_id, candidate}


@socketio.on("call:media-state")
def sio_media_state(data):
    _relay("call:media-state", data)   # {call_id, mic, cam}


if __name__ == "__main__":
    # socketio.run wraps app.run and upgrades it with WebSocket support.
    socketio.run(app, host="0.0.0.0", port=5000, debug=True, allow_unsafe_werkzeug=True)
