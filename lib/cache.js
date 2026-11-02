// Disk cache keyed by URL. Stores JSON blobs in ~/.config/bnz/cache/.
//
// Default TTL: 5 minutes. The cache is content-agnostic — callers decide what
// to store. Writes are atomic (write to a tempfile, then rename).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const DEFAULT_TTL_MS = 5 * 60_000;
export const CACHE_DIR = join(homedir(), '.config', 'bnz', 'cache');

export function cacheKey(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

function cachePath(url) {
  return join(CACHE_DIR, cacheKey(url) + '.json');
}

export function readCache(url, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const path = cachePath(url);
  try {
    statSync(path);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.ts !== 'number') return null;
  if (ttlMs > 0 && Date.now() - parsed.ts > ttlMs) return null;
  if (parsed.url && parsed.url !== url) return null;
  return parsed.value;
}

export function writeCache(url, value) {
  const path = cachePath(url);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify({ ts: Date.now(), url, value }));
  renameSync(tmp, path);
}

export function deleteCache(url) {
  rmSync(cachePath(url), { force: true });
}
