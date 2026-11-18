import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type AudioConfig = {
  baseUrl: string;
  api: 'openai-completions' | 'openai-responses';
  audioDataFormat: 'base64' | 'data-url';
  model: string;
  apiKey?: string;
  apiKeyEnv?: string;
  requestParams: Record<string, unknown>;
  limits: { timeoutMs: number; maxEncodedAudioBytes: number; maxItemsPerRequest: number };
  retry: { maxAttempts: number; baseDelayMs: number };
};

const reserved = new Set([
  'model', 'messages', 'stream', 'stream_options', 'modalities', 'audio',
  'tools', 'tool_choice', 'functions', 'function_call', 'n', 'input', 'store', 'previous_response_id', 'conversation',
]);

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numbers<T extends Record<string, number>>(value: unknown, defaults: T, zero: string[] = []): T {
  if (value === undefined) return defaults;
  if (!isObject(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) {
    throw new Error(`Expected settings: ${Object.keys(defaults).join(', ')}.`);
  }
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isSafeInteger(number) || (number as number) < (zero.includes(key) ? 0 : 1)) {
      throw new Error(`${key} requires a ${zero.includes(key) ? 'nonnegative' : 'positive'} integer.`);
    }
  }
  return { ...defaults, ...value };
}

export async function loadConfig(root: string): Promise<AudioConfig> {
  const path = join(root, '.pi', 'audio-ask.local.json');
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, 'utf8')); } catch {
    throw new Error(`Configure ${path} using audio-ask.example.json.`);
  }
  if (!isObject(raw)) throw new Error('Audio configuration must be an object.');
  const allowed = new Set(['baseUrl', 'api', 'audioDataFormat', 'model', 'apiKey', 'apiKeyEnv', 'requestParams', 'limits', 'retry']);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new Error('Use the fields in audio-ask.example.json.');
  for (const key of ['baseUrl', 'model']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error(`Audio configuration requires ${key}.`);
  }
  let url: URL;
  try { url = new URL(raw.baseUrl as string); } catch { throw new Error('Audio baseUrl must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP(S) baseUrl and supply credentials through apiKey or apiKeyEnv.');
  }
  if (raw.apiKey !== undefined && (typeof raw.apiKey !== 'string' || /[\r\n]/.test(raw.apiKey))) {
    throw new Error('apiKey must be a single-line string.');
  }
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : undefined;
  if (raw.apiKeyEnv !== undefined && (typeof raw.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.apiKeyEnv))) {
    throw new Error('apiKeyEnv must name an environment variable.');
  }
  if (!apiKey && !raw.apiKeyEnv) throw new Error('Configure apiKey or apiKeyEnv.');
  const api = raw.api ?? 'openai-completions';
  if (api !== 'openai-completions' && api !== 'openai-responses') throw new Error('Use openai-completions or openai-responses for api.');
  const audioDataFormat = raw.audioDataFormat ?? (api === 'openai-responses' ? 'data-url' : 'base64');
  if (audioDataFormat !== 'base64' && audioDataFormat !== 'data-url') throw new Error('Use base64 or data-url for audioDataFormat.');
  if (api === 'openai-responses' && audioDataFormat !== 'data-url') throw new Error('Qwen Responses requires audioDataFormat: data-url.');
  const requestParams = raw.requestParams ?? {};
  if (!isObject(requestParams) || Object.keys(requestParams).some(key => reserved.has(key))) {
    throw new Error('requestParams accepts model options; Pi Audio Ask controls messages, model and tool execution.');
  }
  const limits = numbers(raw.limits, { timeoutMs: 120000, maxEncodedAudioBytes: 8000000, maxItemsPerRequest: 8 });
  const retry = numbers(raw.retry, { maxAttempts: 3, baseDelayMs: 1000 }, ['baseDelayMs']);
  if (limits.timeoutMs > 2147483647 || retry.baseDelayMs > 2147483647) throw new Error('Timer values must fit a Node timer.');
  return {
    baseUrl: url.href.replace(/\/+$/, ''), api, audioDataFormat, model: (raw.model as string).trim(),
    apiKey, apiKeyEnv: raw.apiKeyEnv as string | undefined,
    requestParams, limits, retry,
  };
}
