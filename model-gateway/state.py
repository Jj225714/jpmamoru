"""SQLite authentication and atomic daily reservations; in-process active-call slots."""

import hashlib
import os
import secrets
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

SESSION_TTL = 12 * 60 * 60
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")


class StateError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def digest(kind, value):
    return hashlib.sha256((kind + "\0" + value).encode("utf-8")).hexdigest()


class State:
    def __init__(self, config, clock=time.time):
        self.config, self.clock = config, clock
        directory = Path(config.state_dir)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "gateway.sqlite3"
        # The server is a single process with multiple handler threads.
        self._lock = threading.Lock()
        self._active = 0
        self._images = set()
        self._admitted = 0
        self._admitted_bytes = 0
        self._admitted_images = set()
        with self._db() as db:
            if db.execute("PRAGMA user_version").fetchone()[0] not in (0, 1):
                raise ValueError("Unsupported state schema version")
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS principals (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    code_hash TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                    image_limit INTEGER NOT NULL, text_limit INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
                    expires REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal_id);
                CREATE TABLE IF NOT EXISTS usage (
                    day TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
                    used INTEGER NOT NULL, PRIMARY KEY(day, owner, kind));
                CREATE TABLE IF NOT EXISTS login_attempts (
                    ip_hash TEXT PRIMARY KEY, start REAL NOT NULL, count INTEGER NOT NULL);
                PRAGMA user_version=1;
            """)
            if "rules_admin" not in {row[1] for row in db.execute("PRAGMA table_info(principals)")}:
                db.execute("ALTER TABLE principals ADD COLUMN rules_admin INTEGER NOT NULL DEFAULT 0")
        if os.name == "posix":
            self.path.chmod(0o600)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(self.path, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def day(self):
        return datetime.fromtimestamp(self.clock(), SHANGHAI).date().isoformat()

    def create_code(self, name, image_limit=None, text_limit=None):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100 or any(ord(c) < 32 for c in name):
            raise ValueError("Invalid principal name")
        image_limit = self.config.image_daily_limit if image_limit is None else image_limit
        text_limit = self.config.text_daily_limit if text_limit is None else text_limit
        self._limits(image_limit, text_limit)
        code, principal_id = secrets.token_urlsafe(32), str(uuid.uuid4())
        with self._db() as db:
            db.execute("INSERT INTO principals (id,name,code_hash,enabled,image_limit,text_limit) VALUES (?,?,?,1,?,?)",
                       (principal_id, name.strip(), digest("code", code), image_limit, text_limit))
        return principal_id, code

    @staticmethod
    def _limits(*values):
        if any(type(v) is not int or not 0 <= v <= 1000000 for v in values):
            raise ValueError("Invalid quota limit")

    def disable(self, principal_id):
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            found = db.execute("UPDATE principals SET enabled=0 WHERE id=?", (principal_id,)).rowcount
            db.execute("DELETE FROM sessions WHERE principal_id=?", (principal_id,))
            db.commit()
        if not found:
            raise ValueError("Principal not found")

    def set_quotas(self, principal_id, image_limit, text_limit):
        self._limits(image_limit, text_limit)
        with self._db() as db:
            found = db.execute("UPDATE principals SET image_limit=?,text_limit=? WHERE id=?",
                               (image_limit, text_limit, principal_id)).rowcount
        if not found:
            raise ValueError("Principal not found")

    def list_principals(self):
        with self._db() as db:
            rows = db.execute("SELECT id,name,enabled,image_limit,text_limit,rules_admin FROM principals ORDER BY name,id").fetchall()
        return [dict(row, quota=self.quota(row)) for row in rows]

    def set_rules_admin(self, principal_id, enabled):
        with self._db() as db:
            found = db.execute("UPDATE principals SET rules_admin=? WHERE id=?", (int(enabled), principal_id)).rowcount
        if not found:
            raise ValueError("Principal not found")

    def login(self, code, ip):
        now = self.clock()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM login_attempts WHERE start<=?", (now - 900,))
            ip_hash = digest("ip", ip)
            row = db.execute("SELECT count FROM login_attempts WHERE ip_hash=?", (ip_hash,)).fetchone()
            if row and row[0] >= 10:
                db.commit()
                raise StateError(429, "login_rate_limit", "Too many login attempts. Try again later.")
            db.execute("INSERT INTO login_attempts VALUES (?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET count=count+1",
                       (ip_hash, now))
            principal = db.execute("SELECT * FROM principals WHERE code_hash=? AND enabled=1",
                                   (digest("code", code),)).fetchone()
            if principal is None:
                db.commit()
                raise StateError(401, "invalid_code", "Invalid access code.")
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires<=?", (now,))
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (digest("session", token), principal["id"], now + SESSION_TTL))
            db.commit()
        return token, dict(principal)

    def _authenticate(self, db, token):
        if not isinstance(token, str) or len(token) > 128:
            return None
        return db.execute("""SELECT p.* FROM sessions s JOIN principals p ON p.id=s.principal_id
            WHERE s.token_hash=? AND s.expires>? AND p.enabled=1""",
                          (digest("session", token), self.clock())).fetchone()

    def authenticate(self, token):
        with self._db() as db:
            row = self._authenticate(db, token)
        return dict(row) if row else None

    def logout(self, token):
        with self._db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (digest("session", token),))

    def quota(self, principal):
        day = self.day()
        with self._db() as db:
            used = dict(db.execute("SELECT kind,used FROM usage WHERE day=? AND owner=?", (day, principal["id"])).fetchall())
        return {"day": day, "images": {"used": used.get("images", 0), "limit": principal["image_limit"]},
                "text": {"used": used.get("text", 0), "limit": principal["text_limit"]}}

    @contextmanager
    def admit(self, token, kind, size):
        """Bound body parsing AND calls before reading bytes, without charging quota.

        Besides four total slots, share a 128 MiB declared-body budget: four
        concurrent maximum-size multipart parsers would exceed the service RAM.
        Keep each slot until response completion to account for parsed copies.
        """
        if kind not in ("images", "text") or type(size) is not int or not 0 <= size <= 128 * 1024 * 1024:
            raise ValueError("Invalid resource admission")
        with self._lock:
            principal = self.authenticate(token)
            if principal is None:
                raise StateError(401, "authentication_required", "Sign in with your access code.")
            owner = principal["id"]
            if (self._admitted >= 4 or self._admitted_bytes + size > 128 * 1024 * 1024
                    or (kind == "images" and owner in self._admitted_images)):
                raise StateError(429, "concurrency_limit", "Another request is active. Try again later.")
            self._admitted += 1
            self._admitted_bytes += size
            if kind == "images":
                self._admitted_images.add(owner)
        try:
            yield
        finally:
            with self._lock:
                self._admitted -= 1
                self._admitted_bytes -= size
                if kind == "images":
                    self._admitted_images.remove(owner)

    @contextmanager
    def reserve(self, token, kind, count=1):
        """Acquire slots and commit quota atomically before a single upstream attempt.

        No refund after entry: a network exception may follow a paid dispatch.
        Slots are released for every exception, including client disconnects.
        """
        if kind not in ("images", "text") or type(count) is not int or not 1 <= count <= (15 if kind == "images" else 1):
            raise ValueError("Invalid reservation")
        with self._lock:
            with self._db() as db:
                db.execute("BEGIN IMMEDIATE")
                principal = self._authenticate(db, token)
                if principal is None:
                    raise StateError(401, "authentication_required", "Sign in with your access code.")
                owner = principal["id"]
                if self._active >= 4 or (kind == "images" and owner in self._images):
                    raise StateError(429, "concurrency_limit", "Another request is active. Try again later.")
                local_limit = principal["image_limit" if kind == "images" else "text_limit"]
                global_limit = self.config.global_image_daily_limit if kind == "images" else self.config.global_text_daily_limit
                day = self.day()
                for target, limit in ((owner, local_limit), ("__global__", global_limit)):
                    row = db.execute("SELECT used FROM usage WHERE day=? AND owner=? AND kind=?", (day, target, kind)).fetchone()
                    if (row[0] if row else 0) + count > limit:
                        raise StateError(429, "quota_exceeded", "Daily quota reached.")
                for target in (owner, "__global__"):
                    db.execute("INSERT INTO usage VALUES (?,?,?,?) ON CONFLICT(day,owner,kind) DO UPDATE SET used=used+excluded.used",
                               (day, target, kind, count))
                db.commit()
                self._active += 1
                if kind == "images":
                    self._images.add(owner)
        try:
            yield dict(principal)
        finally:
            with self._lock:
                self._active -= 1
                if kind == "images":
                    self._images.remove(owner)
