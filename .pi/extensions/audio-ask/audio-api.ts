import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AudioConfig } from './config.ts';
import { isObject } from './config.ts';
import type { PreparedSource } from './media.ts';

export type TokenUsage = {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  audioInputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number;
};
export type ModelAnswer = { answer: string; responseModel?: string; requestId?: string; usage: TokenUsage | null };
export type PreparedItem = { id: string; label?: string; sources: PreparedSource[] };

export class AudioServiceError extends Error {
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Audio service returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1024 * 1024) throw new Error('Audio service response exceeds 1 MiB; request a shorter answer.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      throw new Error('Audio service returned invalid JSON; use a non-streaming audio endpoint.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null;
  const usage: TokenUsage = {};
  const input = value.input_tokens_details ?? value.prompt_tokens_details;
  const output = value.output_tokens_details ?? value.completion_tokens_details;
  const fields = {
    inputTokens: value.input_tokens ?? value.prompt_tokens, outputTokens: value.output_tokens ?? value.completion_tokens,
    totalTokens: value.total_tokens,
    audioInputTokens: isObject(input) ? input.audio_tokens : undefined, cachedInputTokens: isObject(input) ? input.cached_tokens : undefined,
    reasoningTokens: isObject(output) ? output.reasoning_tokens : undefined,
  };
  for (const [key, count] of Object.entries(fields)) {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[key as keyof TokenUsage] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

const protocols = {
  'openai-completions': {
    path: 'chat/completions', textType: 'text',
    audio: (data: string, format: string) => ({ type: 'input_audio', input_audio: { data, format } }),
    body: (content: Content, _question: string, _continuation: ContinuationOptions) => ({ messages: [{ role: 'user', content }], modalities: ['text'] }),
    answer(raw: Record<string, unknown>) {
      const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
      if (isObject(choice) && choice.finish_reason === 'stop' && isObject(choice.message) && !choice.message.tool_calls) return choice.message.content;
    },
  },
  'openai-responses': {
    path: 'responses', textType: 'input_text',
    audio: (data: string, format: string) => ({ type: 'input_audio', data, format }),
    body: (content: Content, question: string, continuation: ContinuationOptions) => ({
      store: continuation.store,
      ...(continuation.previousResponseId
        ? { input: question, previous_response_id: continuation.previousResponseId }
        : { input: [{ role: 'user', content }] }),
    }),
    answer(raw: Record<string, unknown>) {
      if (raw.status === 'completed' && Array.isArray(raw.output) && raw.output.every(item => isObject(item) && (item.type === 'reasoning' || item.type === 'message'))) {
        return raw.output.flatMap(item => item.type === 'message' && Array.isArray(item.content)
          ? item.content.filter((part: unknown) => isObject(part) && part.type === 'output_text' && typeof part.text === 'string').map((part: { text: string }) => part.text)
          : []).join('\n');
      }
    },
  },
};
type Content = Record<string, unknown>[];
type ContinuationOptions = { store: boolean; previousResponseId?: string };

export async function prepareAudioRequest(
  config: AudioConfig, apiKey: string, items: PreparedItem[], question: string,
  continuation: ContinuationOptions, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<(signal: AbortSignal) => Promise<ModelAnswer>> {
  signal.throwIfAborted();
  const protocol = protocols[config.api];
  const text = (text: string) => ({ type: protocol.textType, text });
  const content: Content = [text(`Audio groups in this request: ${items.map(item => item.id).join(', ')}.`)];
  const encoded: string[] = [];
  for (const item of items) {
    content.push(text(`${item.id}${item.label ? `: ${item.label}` : ''}`));
    for (const source of item.sources) {
      const data = await readFile(source.path, { signal });
      if (createHash('sha256').update(data).digest('hex') !== source.record.submitted.sha256) {
        throw new Error(`${source.record.id} changed after preparation; retry with a stable file.`);
      }
      const bytes = data.toString('base64');
      encoded.push(bytes);
      const { id, label, start, end, submitted } = source.record;
      content.push(
        text(`${id}${label ? ` (${label})` : ''}: clip 0 seconds = source ${submitted.start} seconds. Submitted source interval [${submitted.start}, ${submitted.end}); requested interval [${start}, ${end}). Use source seconds and source IDs for timestamps.`),
        protocol.audio(config.audioDataFormat === 'data-url' ? `data:${source.mimeType};base64,${bytes}` : bytes, submitted.format),
      );
    }
  }
  content.push(text(question));
  const body = JSON.stringify({
    ...config.requestParams, model: config.model, stream: false,
    ...protocol.body(content, question, continuation),
  });
  const redact = (text: string) => {
    let safe = text.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/gi, '[omitted inline data]');
    for (const bytes of encoded) safe = safe.replaceAll(bytes, '[omitted audio]');
    return safe.replaceAll(apiKey, '[redacted credential]');
  };
  return async signal => {
    const raw = await send(`${config.baseUrl}/${protocol.path}`, apiKey, body, signal, fetchImpl, redact);
    const answer = protocol.answer(raw);
    if (typeof answer !== 'string' || !answer.trim()) {
      const reason = config.api === 'openai-responses' ? detailOf(raw, redact) : '';
      throw new Error(reason ? `Audio service response: ${reason}.` : 'Audio service returned an incomplete, empty or tool-calling answer; adjust output limits or use a text-answer model.');
    }
    const shortText = (value: unknown) => typeof value === 'string' ? redact(value).slice(0, 256) : undefined;
    return { answer: redact(answer), responseModel: shortText(raw.model), requestId: shortText(raw.id), usage: usageOf(raw.usage) };
  };
}

function detailOf(raw: unknown, redact: (text: string) => string): string {
  if (!isObject(raw)) return '';
  const error = isObject(raw.error) ? raw.error : raw;
  const incomplete = isObject(raw.incomplete_details) ? raw.incomplete_details.reason : undefined;
  const brief = (part: unknown) => typeof part === 'string'
    ? redact(part).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : '';
  return [raw.status === 'completed' ? undefined : raw.status, error.code, error.param, error.message, incomplete]
    .map(brief).filter(Boolean).join(' · ');
}

async function send(
  url: string, apiKey: string, body: string, signal: AbortSignal, fetchImpl: typeof fetch, redact: (text: string) => string,
) {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'manual', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch {
    signal.throwIfAborted();
    throw new AudioServiceError('Audio service connection failed.', true);
  }
  if (!response.ok) {
    const value = response.headers.get('retry-after');
    const seconds = value === null || value.trim() === '' ? NaN : Number(value);
    const wait = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : NaN;
    const detail = detailOf(await readResponse(response, signal).catch(() => undefined), redact);
    throw new AudioServiceError(
      `Audio service HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      Number.isFinite(wait) ? Math.max(0, wait) : undefined,
    );
  }
  let raw: unknown;
  try { raw = await readResponse(response, signal); } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith('Audio service')) throw error;
    throw new AudioServiceError('Audio service response connection failed.', true);
  }
  if (!isObject(raw)) throw new Error('Audio service returned an invalid response.');
  return raw;
}
