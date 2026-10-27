import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM for secrets at rest (LLM API keys, SMTP app password)
const key = crypto.createHash('sha256').update(`enc:${config.appSecret}`).digest();

export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function mask(secret) {
  if (!secret) return '';
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}

export function hmac(value) {
  return crypto.createHmac('sha256', config.appSecret).update(String(value)).digest('hex');
}
