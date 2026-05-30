const express = require('express');
const pool = require('../db');
const authenticate = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const { uploadToR2 } = require('../lib/r2');
const { checkUploadedFile } = require('../lib/childSafety');
const { v4: uuidv4 } = require('uuid');

const ALLOWED_IMAGE_TYPES = ['image/jpeg','image/png','image/gif','image/webp'];
const ALLOWED_VIDEO_TYPES = ['image/gif','video/mp4','video/quicktime'];
const ALLOWED_FILE_TYPES  = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'];
const BLOCKED_TYPES = ['application/x-executable','application/x-msdownload','application/x-sh','application/x-bat'];

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isBlocked = BLOCKED_TYPES.includes(file.mimetype) || /\.(exe|bat|sh|cmd|msi|vbs|ps1)$/i.test(file.originalname);
    cb(isBlocked ? new Error('File type not allowed') : null, !isBlocked);
  },
});

const router = express.Router();

// GET /api/chat/rooms
router.get('/rooms', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.*,
         (SELECT created_at FROM chat_messages WHERE room_id = r.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
       FROM chat_rooms r
       WHERE r.is_public = TRUE
       ORDER BY r.pinned DESC, r.created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms
router.post('/rooms', authenticate, async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const slug = name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!slug) return res.status(400).json({ error: 'Invalid room name' });

    const result = await pool.query(
      `INSERT INTO chat_rooms (name, slug, description, created_by, is_public)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [name.trim(), slug, description?.trim() || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A room with that name already exists' });
    next(err);
  }
});

// GET /api/chat/rooms/:slug/messages
router.get('/rooms/:slug/messages', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.room_id, m.user_id, m.content, m.created_at,
              m.media_url, m.media_type, m.media_filename, m.media_size, m.media_duration,
              u.username, r.slug AS room_slug
       FROM chat_messages m
       JOIN users u ON u.id = m.user_id
       JOIN chat_rooms r ON r.id = m.room_id
       WHERE r.slug = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [req.params.slug]
    );
    res.json(result.rows.reverse());
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms/:slug/report
router.post('/rooms/:slug/report', authenticate, async (req, res, next) => {
  try {
    const room = await pool.query('SELECT id FROM chat_rooms WHERE slug = $1', [req.params.slug]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });

    await pool.query(
      `INSERT INTO room_reports (room_id, user_id) VALUES ($1, $2) ON CONFLICT (room_id, user_id) DO NOTHING`,
      [room.rows[0].id, req.user.id]
    );
    await pool.query('UPDATE chat_rooms SET flagged = TRUE WHERE id = $1', [room.rows[0].id]);
    res.json({ reported: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/rooms/:slug/upload — upload media to R2
router.post('/rooms/:slug/upload', authenticate, chatUpload.single('file'), async (req, res, next) => {
  try {
    const room = await pool.query('SELECT id FROM chat_rooms WHERE slug = $1', [req.params.slug]);
    if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });

    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file provided' });

    const mime = file.mimetype;
    let mediaType;
    if (ALLOWED_IMAGE_TYPES.includes(mime) && mime !== 'image/gif') mediaType = 'image';
    else if (ALLOWED_VIDEO_TYPES.includes(mime) || mime === 'image/gif') mediaType = mime === 'image/gif' ? 'gif' : 'video';
    else if (ALLOWED_FILE_TYPES.includes(mime)) mediaType = 'file';
    else return res.status(400).json({ error: 'File type not allowed' });

    // Size limits by type
    if (mediaType === 'image' && file.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Images must be under 10MB' });
    if (mediaType === 'video' && file.size > 50 * 1024 * 1024) return res.status(400).json({ error: 'Videos must be under 50MB' });
    if (mediaType === 'file' && file.size > 25 * 1024 * 1024) return res.status(400).json({ error: 'Files must be under 25MB' });

    // Child safety hash check on all images
    if (mediaType === 'image') {
      const safetyResult = await checkUploadedFile({
        buffer: file.buffer,
        userId: req.user.id,
        ipAddress: req.ip,
        route: `/api/chat/rooms/${req.params.slug}/upload`,
      });
      if (safetyResult?.blocked) {
        return res.status(451).json({ error: 'File blocked by content safety system' });
      }
    }

    const timestamp = Date.now();
    const ext = file.originalname.split('.').pop();
    const filename = `${timestamp}-${uuidv4()}.${ext}`;
    const folder = `chat/${room.rows[0].id}`;
    const url = await uploadToR2(file.buffer, filename, folder);

    res.json({
      url,
      media_type: mediaType,
      media_filename: file.originalname,
      media_size: file.size,
    });
  } catch (err) { next(err); }
});


// POST /api/chat/rooms/:slug/export-pdf
router.post('/rooms/:slug/export-pdf', authenticate, async (req, res, next) => {
  try {
    const roomRes = await pool.query('SELECT * FROM chat_rooms WHERE slug = $1', [req.params.slug]);
    if (!roomRes.rows[0]) return res.status(404).json({ error: 'Room not found' });
    const room = roomRes.rows[0];

    const { messages = [] } = req.body;

    const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${room.slug}-export.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).fillColor('#00ff88').text('Mycelium Community Platform', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(16).fillColor('#ffffff').text(`Chat Room: ${room.name}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#888888').text(`Exported: ${new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#888888').text(`Messages: ${messages.length}`, { align: 'center' });

    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#333333').lineWidth(1).stroke();
    doc.moveDown();

    // Messages
    for (const msg of messages) {
      const ts = new Date(msg.created_at).toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      });
      doc.fontSize(9).fillColor('#888888').text(`[${ts}]  `, { continued: true });
      doc.fontSize(10).fillColor('#00cc77').text(`${msg.username}: `, { continued: true });
      if (msg.media_url) {
        doc.fontSize(10).fillColor('#aaaaaa').text(`[Media: ${msg.media_filename || 'file'} — ${msg.media_url}]`);
      } else {
        doc.fontSize(10).fillColor('#dddddd').text(msg.content || '');
      }
      doc.moveDown(0.4);
    }

    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#333333').lineWidth(0.5).stroke();
    doc.moveDown(0.5);

    // Footer with page numbers
    const pageCount = doc.bufferedPageRange().count || 1;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#555555');
      doc.text(
        `Mycelium Community Platform  |  Governed by the Community Covenant  |  Page ${i + 1} of ${pageCount}`,
        50, doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100 }
      );
    }

    doc.end();
  } catch (err) { next(err); }
});

module.exports = router;
