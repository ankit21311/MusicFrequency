# Hz — Frequency Music Platform

A full-stack music platform with **Low Frequency** and **High Frequency** music categories.

- **Backend**: Node.js + Express
- **Database**: MongoDB Atlas (metadata) + GridFS (audio files)
- **Frontend**: Vanilla HTML/CSS/JS
- **Deploy**: Render

---

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up MongoDB Atlas (free)
1. Go to [mongodb.com/atlas](https://www.mongodb.com/cloud/atlas/register) → create a free account
2. Create a **free M0 cluster** (512 MB, no credit card)
3. Click **Connect** → **Drivers** → copy the connection string
4. In **Database Access**: create a user with read/write permissions
5. In **Network Access**: add `0.0.0.0/0` (allow all IPs — required for Render)

### 3. Create your .env file
```bash
cp .env.example .env
```
Then edit `.env` and paste your MongoDB URI:
```
MONGODB_URI=mongodb+srv://youruser:yourpassword@cluster0.xxxxx.mongodb.net/hz_music?retryWrites=true&w=majority
PORT=3000
ADMIN_USERNAME=Gauravi
ADMIN_PASSWORD=Gauravi@1234
```

### 4. Run the server
```bash
npm run dev     # with nodemon (auto-restart on changes)
# or
npm start       # plain node
```

Open [http://localhost:3000](http://localhost:3000)

---

## Deploy on Render

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "initial commit"
# Create a repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/hz-music.git
git push -u origin main
```

### 2. Create a Render Web Service
1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Name**: `hz-music` (or anything)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free

### 3. Add Environment Variables on Render
In your Render service → **Environment** → add:

| Key | Value |
|---|---|
| `MONGODB_URI` | your Atlas connection string |
| `ADMIN_USERNAME` | `Gauravi` |
| `ADMIN_PASSWORD` | `Gauravi@1234` |

> **Note**: Do NOT set `PORT` — Render injects it automatically.

### 4. Deploy
Click **Deploy**. Render will install dependencies and start the server. Your site will be live at `https://your-service-name.onrender.com`.

---

## API Reference

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/tracks` | None | List all tracks |
| `POST` | `/api/tracks` | Admin | Add track (multipart or JSON) |
| `DELETE` | `/api/tracks/:id` | Admin | Delete track + GridFS blob |
| `GET` | `/api/audio/:id` | None | Stream audio from GridFS |
| `POST` | `/api/auth` | None | Validate admin credentials |

Admin routes require `X-Admin-Username` and `X-Admin-Password` headers.

---

## Project Structure

```
AntiGravity/
├── server.js          ← Express server + all API routes
├── package.json
├── .env               ← Local secrets (DO NOT commit)
├── .env.example       ← Template (safe to commit)
├── .gitignore
├── README.md
└── public/
    └── index.html     ← Full frontend (served as static)
```
