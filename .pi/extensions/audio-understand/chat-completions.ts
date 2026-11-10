import type { AudioConfig } from './config.ts';
import { isObject } from './config.ts';
import type { PreparedSource } from './media.ts';

export type TokenUsage = {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  audioInputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number;
};
export type ModelAnswer = { answer: string; responseModel?: string; requestId?: string; usage: TokenUsage | null };

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
      throw new Error('Audio service returned invalid JSON; a non-streaming Chat Completions response is required.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function usageOf(value: unknown): TokenUsage | null {
  if (!isObject(value)) return null;
  const usage: TokenUsage = {};
  const input = isObject(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const output = isObject(value.completion_tokens_details) ? value.completion_tokens_details : {};
  const fields = {
    inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens,
    audioInputTokens: input.audio_tokens, cachedInputTokens: input.cached_tokens, reasoningTokens: output.reasoning_tokens,
  };
  for (const [key, count] of Object.entries(fields)) {
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[key as keyof TokenUsage] = count;
  }
  return Object.keys(usage).length ? usage : null;
}

export async function askAudio(
  config: AudioConfig, apiKey: string, sources: PreparedSource[], question: string,
  signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<ModelAnswer> {
  signal.throwIfAborted();
  const content: Record<string, unknown>[] = [];
  const encoded = sources.map((source) => source.data.toString('base64'));
  for (const [index, source] of sources.entries()) {
    const { id, start, end } = source.record;
    content.push(
      { type: 'text', text: `${id}: this clip's 0 seconds corresponds to ${start} seconds in its source; the requested source range is [${start}, ${end}). Identify the source and time basis when giving timestamps.` },
      { type: 'input_audio', input_audio: { data: `data:${source.mimeType};base64,${encoded[index]}`, format: source.record.submitted.format } },
    );
  }
  content.push({ type: 'text', text: question });
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...config.requestParams, model: config.model, messages: [{ role: 'user', content }], modalities: ['text'], stream: false }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('Audio service connection failed. The request may have reached the service and incurred charges; retry explicitly.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Audio service HTTP ${response.status}. Check endpoint, audio compatibility, model and requestParams. Requests are not retried automatically.`);
  }
  let raw: unknown;
  try { raw = await readResponse(response, signal); } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith('Audio service')) throw error;
    throw new Error('Audio service response could not be read; charges may already have occurred.');
  }
  if (!isObject(raw) || !Array.isArray(raw.choices)) throw new Error('Audio service returned no Chat Completions choices.');
  const choice = raw.choices[0];
  const message = isObject(choice) && isObject(choice.message) ? choice.message : {};
  if (!isObject(choice) || choice.finish_reason !== 'stop' || typeof message.content !== 'string' || !message.content.trim() || message.tool_calls) {
    throw new Error('Audio service returned an incomplete, empty or tool-calling answer; adjust output limits or use a text-answer model.');
  }
  const redact = (text: string) => {
    let safe = text;
    for (const bytes of encoded) safe = safe.replaceAll(bytes, '[omitted audio]');
    return safe.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/g, '[omitted inline data]').replaceAll(apiKey, '[redacted credential]');
  };
  const shortText = (value: unknown) => typeof value === 'string' ? redact(value).slice(0, 256) : undefined;
  return { answer: redact(message.content), responseModel: shortText(raw.model), requestId: shortText(raw.id), usage: usageOf(raw.usage) };
}
