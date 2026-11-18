import { fileURLToPath } from 'node:url';
import { createAudioAsk } from './ask.ts';
import type { AskRequest, AskResult, BatchRequest } from './types.ts';

const textBlock = (text: string) => ({ type: 'text' as const, text });
const source = {
  type: 'object', additionalProperties: false, required: ['path'],
  properties: {
    path: { type: 'string', minLength: 1, description: 'Local audio or media path, relative to the current working directory or absolute.' },
    label: { type: 'string', maxLength: 500, description: 'Optional description of this source.' },
    start: { type: 'number', description: 'Inclusive source seconds; defaults to 0.' },
    end: { type: 'number', description: 'Exclusive source seconds; defaults to source duration.' },
  },
};
const sources = { type: 'array', minItems: 1, items: source };

function formatResult(result: AskResult) {
  const { consultation: record, archive } = result;
  const lines = [
    `${record.title} · ${record.status} · ${record.model}`,
    `Record: ${archive.recordPath}`, `Report: ${archive.reportPath}`, '',
  ];
  if (archive.error) lines.push(archive.error, '');
  if (record.continuation) lines.push(`Continues ${record.continuation.id}; audio ranges below are inherited.`, '');
  if (record.allowContinuation && record.status === 'completed' && record.batches[0]?.requestId && archive.saved) {
    const example = { title: '<follow-up title>', question: '<follow-up question>', continueFrom: archive.recordPath };
    lines.push(`Follow up with audio_ask: ${JSON.stringify(example)}`, '');
  }
  const items = new Map(record.items.map(item => [item.id, item]));
  for (const batch of record.batches) {
    lines.push(`${batch.id}: ${batch.itemIds.join(', ')} · ${batch.status}${batch.responseModel ? ` · ${batch.responseModel}` : ''}`, batch.answer ?? batch.error ?? '', '');
    for (const id of batch.itemIds) {
      const item = items.get(id)!;
      for (const s of item.prepared) lines.push(`  ${s.id}: ${s.path} [${s.start}, ${s.end}); submitted [${s.submitted.start}, ${s.submitted.end}); clip 0 = source ${s.submitted.start} s`);
      items.delete(id);
    }
    lines.push('');
  }
  for (const item of items.values()) {
    lines.push(`${item.id}${item.label ? ` (${item.label})` : ''}: ${item.status} · ${item.sources.map(s => s.path).join(', ')}`);
    if (item.error) lines.push(`  ${item.error}`);
  }
  lines.push(...record.warnings.map(warning => `Note: ${warning}`));
  const full = lines.join('\n');
  const head = full.split('\n').slice(0, 2000).join('\n');
  const text = Buffer.from(head).subarray(0, 48000).toString('utf8').replace(/\uFFFD$/, '');
  return text.length < full.length ? `${text}\n[Truncated. Full report: ${archive.reportPath}; archive saved: ${archive.saved}]` : text;
}

export function createTools(root: string) {
  const engine = createAudioAsk(root);
  return [false, true].map(batch => ({
    name: batch ? 'audio_ask_batch' : 'audio_ask',
    label: batch ? 'Pi Audio Ask · Batch' : 'Pi Audio Ask',
    description: batch
      ? 'Ask a shared free-form question about many audio groups. Automatically packs whole groups into sequential requests within configured limits. Returns each batch answer with its sources and saves a searchable local archive. Text output is capped at 48 KB / 2000 lines; the linked report contains the full result.'
      : 'Choose exactly one: use sources to ask an audio model about local audio ranges together in one request, or continueFrom to ask a new question about audio from a saved Responses consultation. To add new audio, start a new consultation with sources and carry relevant prior findings in question. Saves a searchable local archive. Text output is capped at 48 KB / 2000 lines; the linked report contains the full result.',
    promptSnippet: batch ? 'Ask about many audio groups with automatic request batching' : 'Explore actual sound, discuss creative choices and follow up on audio details',
    promptGuidelines: batch ? [] : [
      'Use audio_ask for focused listening and follow-up; use audio_ask_batch for large audio collections.',
      'Obtain audio service and material authorization under workspace instructions. Within the authorized scope, use audio_ask and audio_ask_batch freely as creative needs develop.',
    ],
    exposure: 'direct' as const,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    parameters: {
      type: 'object', additionalProperties: false, required: batch ? ['title', 'question', 'items'] : ['title', 'question'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Short consultation topic, used for the archive filename.' },
        question: { type: 'string', minLength: 1, maxLength: 65536, description: 'Free-form question, relevant context, prior findings and desired answer format. Shared across batch requests.' },
        ...(batch ? {
          items: {
            type: 'array', minItems: 1,
            description: 'Each group stays together in one remote request.',
            items: { type: 'object', additionalProperties: false, required: ['sources'], properties: { label: { type: 'string', maxLength: 500 }, sources } },
          },
        } : {
          sources: { ...sources, description: 'Audio for a new consultation.' },
          continueFrom: { type: 'string', minLength: 1, description: 'Archived record.json path for a Responses follow-up; uses the prior audio context.' },
          allowContinuation: { type: 'boolean', description: 'Allow the Responses endpoint to store this turn for follow-up. Defaults to true on follow-ups and false for new consultations.' },
        }),
      },
    },
    outputSchema: {
      type: 'object', required: ['consultation', 'archive'],
      properties: { consultation: { type: 'object' }, archive: { type: 'object' } },
    },
    async execute(
      _id: string, params: AskRequest | BatchRequest, signal: AbortSignal | undefined,
      onUpdate: ((result: { content: ReturnType<typeof textBlock>[]; details: undefined }) => void) | undefined,
      ctx: { cwd: string; isProjectTrusted(): boolean },
    ) {
      if (!ctx.isProjectTrusted()) throw new Error('Trust this workspace to use its Pi Audio Ask configuration.');
      const options = { cwd: ctx.cwd, signal, onProgress: (phase: string) => onUpdate?.({ content: [textBlock(phase)], details: undefined }) };
      const result = await (batch ? engine.batch(params as BatchRequest, options) : engine.ask(params as AskRequest, options));
      return {
        isError: result.consultation.status !== 'completed' || !result.archive.saved,
        content: [textBlock(formatResult(result))], details: undefined, structuredContent: result,
      };
    },
  }));
}

export default function piAudioAsk(pi: { registerTool(tool: ReturnType<typeof createTools>[number]): void }) {
  for (const tool of createTools(fileURLToPath(new URL('../../../', import.meta.url)))) pi.registerTool(tool);
}
