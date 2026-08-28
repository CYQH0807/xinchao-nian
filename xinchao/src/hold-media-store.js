import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HOLD_MEDIA_TYPES = Object.freeze([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const HOLD_MEDIA_REF_RE = /^hold-media:[0-9a-f]{32}$/u;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize a media type before allow-list and signature checks. */
function normalizeMediaType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

/** Keep the original filename as harmless display metadata only. */
function normalizeFilename(value) {
  return String(value || 'image')
    .replace(/[\u0000-\u001f\u007f\\/]+/gu, ' ')
    .trim()
    .slice(0, 200) || 'image';
}

/** Decode one strict Base64 value, including an optional data URI prefix. */
function decodeBase64(value) {
  let payload = String(value || '').trim();
  if (payload.startsWith('data:')) {
    const separator = payload.indexOf(',');
    if (separator < 0) throw new Error('hold_media_base64_invalid');
    payload = payload.slice(separator + 1);
  }
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload)) {
    throw new Error('hold_media_base64_invalid');
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.toString('base64') !== payload) throw new Error('hold_media_base64_invalid');
  return bytes;
}

/** Infer an image media type when a compatibility caller uses a data URI. */
function dataUriMediaType(value) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,/iu.exec(String(value || '').trim());
  return match ? normalizeMediaType(match[1]) : '';
}

/** Verify that bytes match the declared image media type. */
function matchesImageSignature(bytes, mediaType) {
  if (mediaType === 'image/jpeg') return bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mediaType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mediaType === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

/** Return the staging token from a queue media entry or reject forged refs. */
function mediaRefOf(entry) {
  const value = String(entry?.media_ref || '').trim();
  if (!HOLD_MEDIA_REF_RE.test(value)) throw new Error('hold_media_reference_invalid');
  return value;
}

/** Return a bounded binary body from an HTTP request. */
export async function readBinaryBody(request, maxBytes) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('hold_media_too_large');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('hold_media_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/**
 * Persist short-lived hold media outside the JSON job queue.
 * The queue receives only a random reference and the worker later materializes it.
 */
export class HoldMediaStore {
  constructor(path, { maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.path = String(path);
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.ttlMs = Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS);
  }

  /** Create the staging directory and remove expired files after startup. */
  async init(now = Date.now()) {
    await mkdir(this.path, { recursive: true, mode: 0o700 });
    await this.cleanup(now);
  }

  /** Stage validated image bytes and return queue-safe metadata. */
  async stage(data, { filename = 'image', mediaType = '' } = {}) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    if (bytes.length === 0) throw new Error('hold_media_empty');
    if (bytes.length > this.maxBytes) throw new Error('hold_media_too_large');
    const type = normalizeMediaType(mediaType);
    if (!HOLD_MEDIA_TYPES.includes(type)) throw new Error('hold_media_type_unsupported');
    if (!matchesImageSignature(bytes, type)) throw new Error('hold_media_invalid_image');

    const id = randomUUID().replaceAll('-', '');
    const mediaRef = `hold-media:${id}`;
    const target = join(this.path, `${id}.bin`);
    const temporary = `${target}.${process.pid}.${randomUUID().replaceAll('-', '')}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
    return {
      media_ref: mediaRef,
      filename: normalizeFilename(filename),
      type,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  }

  /** Decode and stage an inline Base64 image for compatibility with direct MCP callers. */
  async stageBase64(value, metadata = {}) {
    return this.stage(decodeBase64(value), {
      ...metadata,
      mediaType: metadata.mediaType || dataUriMediaType(value),
    });
  }

  /** Check that a previously returned staging reference still exists. */
  async assertAvailable(entry) {
    const mediaRef = mediaRefOf(entry);
    const path = this.pathFor(mediaRef);
    try {
      const details = await stat(path);
      if (!details.isFile()) throw new Error('hold_media_reference_missing');
    } catch (error) {
      if (error.message === 'hold_media_reference_missing') throw error;
      throw new Error('hold_media_reference_missing');
    }
    return mediaRef;
  }

  /** Read staged bytes and convert them to Ombre's accepted Base64 media shape. */
  async materialize(payload = {}) {
    const media = payload?.media;
    if (!media) return payload;
    const items = Array.isArray(media) ? media : [media];
    const materialized = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || !item.media_ref) {
        materialized.push(item);
        continue;
      }
      const mediaRef = await this.assertAvailable(item);
      const bytes = await readFile(this.pathFor(mediaRef));
      if (bytes.length > this.maxBytes) throw new Error('hold_media_too_large');
      const { media_ref: _ignored, ...metadata } = item;
      materialized.push({ ...metadata, data_base64: bytes.toString('base64') });
    }
    return {
      ...payload,
      media: Array.isArray(media) ? materialized : materialized[0],
    };
  }

  /** Remove staged files owned by a completed or discarded job. */
  async release(media) {
    const items = Array.isArray(media) ? media : media ? [media] : [];
    for (const item of items) {
      if (!item?.media_ref || !HOLD_MEDIA_REF_RE.test(String(item.media_ref))) continue;
      try { await unlink(this.pathFor(item.media_ref)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  /** Remove stale staging files while preserving current queue references. */
  async cleanup(now = Date.now()) {
    let names;
    try { names = await readdir(this.path); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const cutoff = Number(now) - this.ttlMs;
    for (const name of names) {
      if (!/^[0-9a-f]{32}\.bin$/u.test(name)) continue;
      const path = join(this.path, name);
      try {
        const details = await stat(path);
        if (details.isFile() && details.mtimeMs < cutoff) await unlink(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  /** Resolve a validated staging reference to a path inside the configured root. */
  pathFor(mediaRef) {
    const value = mediaRefOf({ media_ref: mediaRef });
    return join(this.path, `${value.slice('hold-media:'.length)}.bin`);
  }
}

/** Normalize inbound hold media and stage bytes before the JSON job is written. */
export async function stageHoldMediaArgs(store, args = {}) {
  const media = args?.media;
  if (!media) return { payload: args, stagedRefs: [] };
  const items = Array.isArray(media) ? media : [media];
  const stagedRefs = [];
  try {
    const normalized = [];
    for (const item of items) {
      if (typeof item === 'string' || !item || typeof item !== 'object') {
        throw new Error('hold_media_entry_invalid');
      }
      let staged;
      if (item.media_ref) {
        await store.assertAvailable(item);
        const type = normalizeMediaType(item.type || 'image/png');
        if (!HOLD_MEDIA_TYPES.includes(type)) throw new Error('hold_media_type_unsupported');
        staged = {
          media_ref: mediaRefOf(item),
          filename: normalizeFilename(item.filename || item.title || 'image'),
          type,
          ...(item.title ? { title: String(item.title).slice(0, 200) } : {}),
          ...(item.note ? { note: String(item.note).slice(0, 500) } : {}),
          ...(item.sha256 ? { sha256: String(item.sha256).slice(0, 64) } : {}),
          ...(Number.isFinite(Number(item.size)) ? { size: Number(item.size) } : {}),
        };
      } else if (item.data_base64) {
        staged = await store.stageBase64(item.data_base64, {
          filename: item.filename || item.title || 'image',
          mediaType: item.type || item.mime_type || '',
        });
        staged = {
          ...staged,
          ...(item.title ? { title: String(item.title).slice(0, 200) } : {}),
          ...(item.note ? { note: String(item.note).slice(0, 500) } : {}),
        };
        stagedRefs.push(staged.media_ref);
      } else if (item.path) {
        throw new Error('hold_media_path_unsupported');
      } else {
        throw new Error('hold_media_entry_invalid');
      }
      normalized.push(staged);
    }
    return { payload: { ...args, media: normalized }, stagedRefs };
  } catch (error) {
    await store.release(stagedRefs.map((media_ref) => ({ media_ref })));
    throw error;
  }
}
