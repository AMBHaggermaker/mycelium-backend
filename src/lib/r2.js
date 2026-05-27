const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const crypto = require('crypto');

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;
// Construct public base URL: https://{bucket}.{account-id}.r2.cloudflarestorage.com
const PUBLIC_BASE = process.env.R2_PUBLIC_URL ||
  `https://${BUCKET}.${process.env.R2_ENDPOINT.replace('https://', '')}`;

async function uploadToR2(buffer, originalName, folder = 'media') {
  const ext  = path.extname(originalName).toLowerCase() || '.bin';
  const key  = `${folder}/${crypto.randomUUID()}${ext}`;
  const mime = mimeFromExt(ext);

  await r2.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        buffer,
    ContentType: mime,
  }));

  return `${PUBLIC_BASE}/${key}`;
}

async function deleteFromR2(url) {
  try {
    const key = url.replace(`${PUBLIC_BASE}/`, '');
    if (!key || key === url) return; // not an R2 URL
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (e) {
    console.error('[r2] delete failed:', e.message);
  }
}

function mimeFromExt(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

module.exports = { uploadToR2, deleteFromR2 };
