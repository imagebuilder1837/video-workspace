import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AudioConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  requestParams: Record<string, unknown>;
  limits: { timeoutMs: number; maxEncodedAudioBytes: number; cacheMaxAgeMs: number };
};

const reserved = new Set([
  'model', 'messages', 'stream', 'stream_options', 'modalities', 'audio',
  'tools', 'tool_choice', 'functions', 'function_call', 'n',
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function loadConfig(workspaceRoot: string): Promise<AudioConfig> {
  const path = join(workspaceRoot, '.pi', 'audio-understand.local.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new Error(`Configure ${path} using audio-understand.example.json.`);
    }
    throw new Error(`Cannot read valid JSON from ${path}.`);
  }
  if (!isObject(raw)) throw new Error('Audio configuration must be an object.');
  const allowed = new Set(['baseUrl', 'model', 'apiKey', 'apiKeyEnv', 'requestParams', 'limits']);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw new Error('Unknown audio configuration field; use the example configuration.');
  }
  for (const key of ['baseUrl', 'model']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) {
      throw new Error(`Audio configuration requires a nonempty ${key}.`);
    }
  }
  let url: URL;
  try { url = new URL(raw.baseUrl as string); } catch {
    throw new Error('Audio baseUrl must be an absolute HTTP(S) URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Audio baseUrl must use HTTP(S), with credentials supplied through apiKey or apiKeyEnv.');
  }
  if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || /[\r\n]/.test(raw.apiKey))) {
    throw new Error('apiKey must be a single-line string.');
  }
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : undefined;
  if (raw.apiKeyEnv !== undefined && (typeof raw.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.apiKeyEnv))) {
    throw new Error('apiKeyEnv must name an environment variable.');
  }
  if (!apiKey && !raw.apiKeyEnv) throw new Error('Configure apiKey or apiKeyEnv.');
  const requestParams = raw.requestParams ?? {};
  if (!isObject(requestParams) || Object.keys(requestParams).some((key) => reserved.has(key))) {
    throw new Error('requestParams must be an object; model, messages, stream, modalities and tool execution are controlled by audio_understand.');
  }
  const limits = { timeoutMs: 120000, maxEncodedAudioBytes: 8000000, cacheMaxAgeMs: 86400000 };
  if (raw.limits !== undefined) {
    if (!isObject(raw.limits) || Object.keys(raw.limits).some((key) => !Object.hasOwn(limits, key))) {
      throw new Error('Unknown audio limit; use timeoutMs, maxEncodedAudioBytes or cacheMaxAgeMs.');
    }
    for (const [key, value] of Object.entries(raw.limits)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'cacheMaxAgeMs' ? 0 : 1)) {
        throw new Error(`Audio limit ${key} must be a ${key === 'cacheMaxAgeMs' ? 'nonnegative' : 'positive'} integer.`);
      }
      if (key === 'timeoutMs' && value > 2147483647) throw new Error('timeoutMs must fit a Node timer (at most 2147483647).');
      limits[key as keyof typeof limits] = value;
    }
  }
  return {
    baseUrl: url.href.replace(/\/+$/, ''), model: (raw.model as string).trim(),
    apiKey, apiKeyEnv: raw.apiKeyEnv as string | undefined, requestParams: { max_tokens: 2048, ...requestParams }, limits,
  };
}
