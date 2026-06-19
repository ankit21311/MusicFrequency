# Hz — Frequency Music Platform

A full-stack music platform with **Low Frequency** and **High Frequency** categories.

- **Backend**: Python + Flask
- **Database**: SQLite (built into Python — no external service needed)
- **File Storage**: SQLite BLOB columns (audio files live inside the DB)
- **Frontend**: Vanilla HTML / CSS / JS
- **Deploy**: Render

---

## Local Development

### 1. Install Python dependencies
```bash
pip install -r requirements.txt
```

### 2. Create your .env file
```bash
cp .env.example .env
```
The defaults work out of the box — no MongoDB URI, no external service.

### 3. Run the server
```bash
python app.py
```

Open [http://localhost:3000](http://localhost:3000)

Admin login: **Gauravi** / **Gauravi@1234**

---

## Deploy on Render

### 1. Push to GitHub
```bash
git add .
git commit -m "switch to python + sqlite"
git push origin main
```

### 2. Create a Render Web Service
1. [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:

| Setting | Value |
|---|---|
| **Runtime** | `Python 3` |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `gunicorn app:app --bind 0.0.0.0:$PORT` |
| **Plan** | Free |

### 3. Add Environment Variables
In Render → **Environment**:

| Key | Value |
|---|---|
| `ADMIN_USERNAME` | `Gauravi` |
| `ADMIN_PASSWORD` | `Gauravi@1234` |
| `DB_PATH` | `hz_music.db` |

> **No MONGODB_URI needed.** SQLite is built into Python.

### 4. Deploy
Click **Deploy**. Your site goes live in ~1 minute.

---

## Persistent Data on Render (optional)

Render free tier has an ephemeral filesystem — the `.db` file resets on every new deploy.

To keep data across deploys:
1. Add a **Render Disk** to your service (Settings → Disks → Add Disk, mount path `/var/data`)
2. Set env var: `DB_PATH=/var/data/hz_music.db`

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tracks` | None | List all track metadata |
| `POST` | `/api/tracks` | Admin | Add track (multipart file or JSON url) |
| `DELETE` | `/api/tracks/<id>` | None | Delete track + its blob |
| `GET` | `/api/audio/<id>` | None | Stream audio from SQLite (range-aware) |
| `POST` | `/api/auth` | None | Validate admin credentials |

Admin routes require `X-Admin-Username` and `X-Admin-Password` headers.

---

## Project Structure

```
AntiGravity/
├── app.py             ← Flask server + all API routes + SQLite
├── requirements.txt   ← flask, python-dotenv, gunicorn
├── Procfile           ← Render start command
├── .env               ← Local secrets (DO NOT commit)
├── .env.example       ← Template (safe to commit)
├── .gitignore
├── README.md
└── public/
    └── index.html     ← Full frontend (served as static)
```
