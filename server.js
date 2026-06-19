require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { GridFSBucket } = require('mongodb');
const path = require('path');
const cors = require('cors');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Gauravi';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Gauravi@1234';

if (!MONGODB_URI) {
  console.error('❌  MONGODB_URI is not set. Create a .env file from .env.example');
  process.exit(1);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer: store uploaded files in memory so we can stream them into GridFS
// multer v2: fileFilter throws an error instead of using a callback
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150 MB max per file
  fileFilter: (req, file, cb) => {
    const allowed = /audio\/(mpeg|ogg|wav|flac|aac|mp4|x-m4a|webm)/i;
    if (allowed.test(file.mimetype) || /\.(mp3|ogg|wav|flac|aac|m4a|webm)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only audio files are allowed'));
    }
  }
});

// ─── MONGOOSE SCHEMA ──────────────────────────────────────────────────────────
const trackSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  artist:    { type: String, trim: true, default: '' },
  type:      { type: String, enum: ['low', 'high'], required: true },
  duration:  { type: String, default: '' },
  source:    { type: String, enum: ['file', 'url'], required: true },
  // URL-type only
  url:       { type: String, default: '' },
  // File-type only (GridFS)
  gridfsId:  { type: mongoose.Schema.Types.ObjectId, default: null },
  fileName:  { type: String, default: '' },
  fileSize:  { type: Number, default: 0 },
  mimeType:  { type: String, default: '' },
}, { timestamps: true });

const Track = mongoose.model('Track', trackSchema);

// ─── GRIDFS BUCKET ────────────────────────────────────────────────────────────
let bucket;

mongoose.connection.once('open', () => {
  bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'audio' });
  console.log('✅  GridFS bucket ready');
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Validate admin credentials sent via the X-Admin-Username / X-Admin-Password
 * headers on every mutating request. Simple but effective for this use-case.
 */
function requireAdmin(req, res, next) {
  const user = req.headers['x-admin-username'];
  const pass = req.headers['x-admin-password'];
  if (user === ADMIN_USERNAME && pass === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorised' });
}

/**
 * Upload a buffer to GridFS and return the new file's ObjectId.
 */
function uploadToGridFS(buffer, filename, mimetype) {
  return new Promise((resolve, reject) => {
    const readable = new Readable();
    readable.push(buffer);
    readable.push(null);

    const uploadStream = bucket.openUploadStream(filename, {
      contentType: mimetype,
    });

    readable.pipe(uploadStream);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.on('error', reject);
  });
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

/* ── GET /api/tracks ────────────────────────────────────────────────────────
   Returns all tracks sorted newest first. No blobs — just metadata.          */
app.get('/api/tracks', async (req, res) => {
  try {
    const tracks = await Track.find().sort({ createdAt: -1 }).lean();
    // Convert ObjectId fields to strings for the frontend
    res.json(tracks.map(t => ({ ...t, _id: t._id.toString(), gridfsId: t.gridfsId?.toString() || null })));
  } catch (err) {
    console.error('GET /api/tracks', err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

/* ── POST /api/tracks ───────────────────────────────────────────────────────
   Add a new track. Two modes:
     - multipart/form-data with an `audio` field  → file upload → GridFS
     - application/json with a `url` field        → URL-based track           */
app.post('/api/tracks', requireAdmin, upload.single('audio'), async (req, res) => {
  try {
    const { name, artist, type, duration, source, url } = req.body;

    if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
    if (!['low', 'high'].includes(type)) return res.status(400).json({ error: 'type must be low or high' });

    let trackData = { name, artist, type, duration, source };

    if (source === 'file') {
      if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
      if (!bucket) return res.status(503).json({ error: 'Storage not ready yet, try again' });

      const gridfsId = await uploadToGridFS(req.file.buffer, req.file.originalname, req.file.mimetype);
      trackData = { ...trackData, gridfsId, fileName: req.file.originalname, fileSize: req.file.size, mimeType: req.file.mimetype };

    } else if (source === 'url') {
      if (!url) return res.status(400).json({ error: 'url is required for URL-type tracks' });
      trackData = { ...trackData, url };

    } else {
      return res.status(400).json({ error: 'source must be file or url' });
    }

    const track = await Track.create(trackData);
    res.status(201).json({ ...track.toObject(), _id: track._id.toString(), gridfsId: track.gridfsId?.toString() || null });

  } catch (err) {
    console.error('POST /api/tracks', err);
    res.status(500).json({ error: err.message || 'Failed to create track' });
  }
});

/* ── DELETE /api/tracks/:id ─────────────────────────────────────────────────
   Deletes track metadata and, if file-sourced, the GridFS blob too.           */
app.delete('/api/tracks/:id', requireAdmin, async (req, res) => {
  try {
    const track = await Track.findById(req.params.id);
    if (!track) return res.status(404).json({ error: 'Track not found' });

    // Remove GridFS file if this was a file upload
    if (track.source === 'file' && track.gridfsId && bucket) {
      try {
        await bucket.delete(track.gridfsId);
      } catch (e) {
        console.warn('GridFS delete warning:', e.message);
      }
    }

    await Track.deleteOne({ _id: track._id });
    res.json({ success: true });

  } catch (err) {
    console.error('DELETE /api/tracks/:id', err);
    res.status(500).json({ error: 'Failed to delete track' });
  }
});

/* ── GET /api/audio/:id ─────────────────────────────────────────────────────
   Streams an audio file from GridFS. Supports HTTP Range requests so the
   browser's native <audio> player can seek correctly.                         */
app.get('/api/audio/:id', async (req, res) => {
  try {
    const objectId = new mongoose.Types.ObjectId(req.params.id);

    // Find the file metadata in GridFS
    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files.length) return res.status(404).json({ error: 'Audio file not found' });

    const file = files[0];
    const fileSize = file.length;
    const contentType = file.contentType || 'audio/mpeg';

    // Handle range requests (essential for audio seeking)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });

      bucket.openDownloadStream(objectId, { start, end: end + 1 }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      bucket.openDownloadStream(objectId).pipe(res);
    }

  } catch (err) {
    console.error('GET /api/audio/:id', err);
    if (err.name === 'BSONError') return res.status(400).json({ error: 'Invalid ID format' });
    res.status(500).json({ error: 'Failed to stream audio' });
  }
});

/* ── POST /api/auth ─────────────────────────────────────────────────────────
   Server-side credential check. Frontend calls this on login.                 */
app.post('/api/auth', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// Catch-all: serve index.html for any non-API route (SPA fallback)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('✅  MongoDB connected');
    app.listen(PORT, () => console.log(`🎵  Hz server running at http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('❌  MongoDB connection failed:', err.message);
    process.exit(1);
  });
