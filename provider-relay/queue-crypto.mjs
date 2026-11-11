import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export function loadQueueKey(file) {
  if (!file) return null;
  const stat = statSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Queue key file must be private (0600)');
  const encoded = readFileSync(file, 'utf8').trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Queue key file must contain a base64 encoded 32-byte key');
  return key;
}

export class QueueCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Invalid queue encryption key');
    this.key = Buffer.from(key);
  }
  seal(value, context) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  open(envelope, context) {
    if (envelope?.version !== 1) throw new Error('Unsupported encrypted queue entry');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
  }
}
