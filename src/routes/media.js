const express = require('express');
const router = express.Router();
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

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
// GET /api/media/profile-photos/uuid.jpg  →  streams object from R2
router.get('/*', async (req, res) => {
  const key = req.params[0];
  if (!key) return res.status(404).end();
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    res.setHeader('Content-Type', data.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    data.Body.pipe(res);
  } catch {
    res.status(404).end();
  }
});

module.exports = router;
