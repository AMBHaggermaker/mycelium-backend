const express = require('express');
const router = express.Router();
const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET;

// Proxy all R2 objects through the backend so no public bucket access is needed.
// Supports HTTP Range requests for audio/video seeking (required by Safari).
// GET /api/media/profile-photos/uuid.jpg  →  streams object from R2
router.get('/*', async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(404).end();
  try {
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      // Fetch with range for audio/video seeking
      const head = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      const total = head.ContentLength;
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      const start = parseInt(match[1], 10);
      const end   = match[2] ? parseInt(match[2], 10) : Math.min(start + 1024 * 1024, total - 1);

      const data = await r2.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key:    key,
        Range:  `bytes=${start}-${end}`,
      }));

      res.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${total}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': end - start + 1,
        'Content-Type':   data.ContentType || 'application/octet-stream',
        'Cache-Control':  'public, max-age=31536000, immutable',
      });
      data.Body.pipe(res);
    } else {
      const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      res.setHeader('Content-Type', data.ContentType || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (data.ContentLength) res.setHeader('Content-Length', data.ContentLength);
      data.Body.pipe(res);
    }
  } catch {
    res.status(404).end();
  }
});

module.exports = router;
