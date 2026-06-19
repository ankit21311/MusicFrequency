import os
import sqlite3
import uuid
import time
from flask import Flask, request, jsonify, Response, send_from_directory
from dotenv import load_dotenv

load_dotenv()

# ─── CONFIG ───────────────────────────────────────────────────────────────────
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "Gauravi")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "Gauravi@1234")
PORT           = int(os.getenv("PORT", 3000))
DB_PATH        = os.getenv("DB_PATH", "hz_music.db")

app = Flask(__name__, static_folder="public", static_url_path="")

# ─── DATABASE ─────────────────────────────────────────────────────────────────
# Python ships with sqlite3 — no extra package needed.
# Audio blobs are stored directly in the DB as BLOB columns.
# NOTE: On Render's free tier the filesystem is ephemeral, so the .db file
# resets on every new deploy. Add a Render Disk ($0.25/GB/month) and set
# DB_PATH=/var/data/hz_music.db to persist data across deploys.

def get_db():
    """Open a per-request SQLite connection with dict-like rows."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create the tracks table if it doesn't exist yet."""
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tracks (
                id          TEXT    PRIMARY KEY,
                name        TEXT    NOT NULL,
                artist      TEXT    DEFAULT '',
                type        TEXT    NOT NULL CHECK(type IN ('low','high')),
                duration    TEXT    DEFAULT '',
                source      TEXT    NOT NULL CHECK(source IN ('file','url')),
                url         TEXT    DEFAULT '',
                audio_blob  BLOB,
                file_name   TEXT    DEFAULT '',
                file_size   INTEGER DEFAULT 0,
                mime_type   TEXT    DEFAULT '',
                created_at  INTEGER DEFAULT (strftime('%s','now'))
            )
        """)
        conn.commit()
    print("✅  SQLite database ready:", DB_PATH)


init_db()


# ─── HELPERS ──────────────────────────────────────────────────────────────────

def require_admin():
    """Return None if valid, or an error Response."""
    u = request.headers.get("X-Admin-Username", "")
    p = request.headers.get("X-Admin-Password", "")
    if u == ADMIN_USERNAME and p == ADMIN_PASSWORD:
        return None
    return jsonify({"error": "Unauthorised"}), 401


def row_to_dict(row):
    """Convert a sqlite3.Row to a plain dict, excluding the raw blob."""
    d = dict(row)
    d.pop("audio_blob", None)          # never send binary data in the JSON list
    d["gridfsId"] = d["id"] if d.get("source") == "file" else None  # frontend compat
    return d


# ─── ROUTES ───────────────────────────────────────────────────────────────────

# ── GET /api/tracks ────────────────────────────────────────────────────────────
@app.route("/api/tracks", methods=["GET"])
def get_tracks():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, artist, type, duration, source, url, "
            "file_name, file_size, mime_type, created_at "
            "FROM tracks ORDER BY created_at DESC"
        ).fetchall()
    return jsonify([row_to_dict(r) for r in rows])


# ── POST /api/tracks ────────────────────────────────────────────────────────────
@app.route("/api/tracks", methods=["POST"])
def add_track():
    err = require_admin()
    if err:
        return err

    track_id = str(uuid.uuid4())

    # Multipart (file upload) vs JSON (URL)
    if request.content_type and "multipart" in request.content_type:
        name     = request.form.get("name", "").strip()
        artist   = request.form.get("artist", "").strip()
        typ      = request.form.get("type", "").strip()
        duration = request.form.get("duration", "").strip()
        source   = request.form.get("source", "file")

        if not name:
            return jsonify({"error": "name is required"}), 400
        if typ not in ("low", "high"):
            return jsonify({"error": "type must be low or high"}), 400

        f = request.files.get("audio")
        if not f:
            return jsonify({"error": "No audio file provided"}), 400

        audio_bytes = f.read()
        mime        = f.mimetype or "audio/mpeg"
        fname       = f.filename or "upload"

        with get_db() as conn:
            conn.execute(
                """INSERT INTO tracks
                   (id, name, artist, type, duration, source,
                    audio_blob, file_name, file_size, mime_type)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (track_id, name, artist, typ, duration, "file",
                 audio_bytes, fname, len(audio_bytes), mime)
            )
            conn.commit()

        return jsonify({
            "id": track_id, "name": name, "artist": artist, "type": typ,
            "duration": duration, "source": "file",
            "fileName": fname, "fileSize": len(audio_bytes),
            "gridfsId": track_id,
        }), 201

    else:
        data     = request.get_json(silent=True) or {}
        name     = (data.get("name") or "").strip()
        artist   = (data.get("artist") or "").strip()
        typ      = (data.get("type") or "").strip()
        duration = (data.get("duration") or "").strip()
        url      = (data.get("url") or "").strip()

        if not name:
            return jsonify({"error": "name is required"}), 400
        if typ not in ("low", "high"):
            return jsonify({"error": "type must be low or high"}), 400
        if not url:
            return jsonify({"error": "url is required for URL-type tracks"}), 400

        with get_db() as conn:
            conn.execute(
                """INSERT INTO tracks
                   (id, name, artist, type, duration, source, url)
                   VALUES (?,?,?,?,?,?,?)""",
                (track_id, name, artist, typ, duration, "url", url)
            )
            conn.commit()

        return jsonify({
            "id": track_id, "name": name, "artist": artist, "type": typ,
            "duration": duration, "source": "url", "url": url,
            "gridfsId": None,
        }), 201


# ── DELETE /api/tracks/<id> ─────────────────────────────────────────────────────
@app.route("/api/tracks/<track_id>", methods=["DELETE"])
def delete_track(track_id):
    err = require_admin()
    if err:
        return err

    with get_db() as conn:
        row = conn.execute(
            "SELECT id FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            return jsonify({"error": "Track not found"}), 404
        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()

    return jsonify({"success": True})


# ── GET /api/audio/<id> ─────────────────────────────────────────────────────────
# Streams the audio blob from SQLite with full HTTP Range support so the
# browser's native <audio> element can seek correctly.
@app.route("/api/audio/<track_id>")
def stream_audio(track_id):
    with get_db() as conn:
        row = conn.execute(
            "SELECT audio_blob, mime_type, file_size FROM tracks WHERE id = ?",
            (track_id,)
        ).fetchone()

    if not row or not row["audio_blob"]:
        return jsonify({"error": "Audio not found"}), 404

    data      = bytes(row["audio_blob"])
    mime      = row["mime_type"] or "audio/mpeg"
    file_size = len(data)

    range_header = request.headers.get("Range")

    if range_header:
        # Parse "bytes=start-end"
        try:
            range_spec  = range_header.replace("bytes=", "")
            parts       = range_spec.split("-")
            byte_start  = int(parts[0]) if parts[0] else 0
            byte_end    = int(parts[1]) if parts[1] else file_size - 1
            byte_end    = min(byte_end, file_size - 1)
            chunk       = data[byte_start: byte_end + 1]
            chunk_size  = byte_end - byte_start + 1

            return Response(
                chunk, 206,
                headers={
                    "Content-Range":  f"bytes {byte_start}-{byte_end}/{file_size}",
                    "Accept-Ranges":  "bytes",
                    "Content-Length": str(chunk_size),
                    "Content-Type":   mime,
                }
            )
        except Exception:
            pass  # fall through to full response

    return Response(
        data, 200,
        headers={
            "Content-Length": str(file_size),
            "Content-Type":   mime,
            "Accept-Ranges":  "bytes",
        }
    )


# ── POST /api/auth ──────────────────────────────────────────────────────────────
@app.route("/api/auth", methods=["POST"])
def auth():
    data = request.get_json(silent=True) or {}
    if data.get("username") == ADMIN_USERNAME and data.get("password") == ADMIN_PASSWORD:
        return jsonify({"success": True})
    return jsonify({"error": "Invalid credentials"}), 401


# ── SPA catch-all ───────────────────────────────────────────────────────────────
@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def catch_all(path):
    return send_from_directory("public", "index.html")


# ─── START ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print(f"🎵  Hz server running at http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
