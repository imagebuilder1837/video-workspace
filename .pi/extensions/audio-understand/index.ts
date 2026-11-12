import { fileURLToPath } from 'node:url';
import { createAudioUnderstanding } from './understand.ts';
import type { AudioQuestion } from './understand.ts';

const textBlock = (text: string) => ({ type: 'text' as const, text });

function createTool(workspaceRoot: string) {
  const understand = createAudioUnderstanding(workspaceRoot);
  return {
    name: 'audio_understand',
    label: 'Audio understanding',
    description: 'Ask a configured audio model about local files or source-time ranges. maxEncodedAudioBytes caps the combined Base64 audio bytes per remote request. Whole sources are batched sequentially; a single oversized source fails the call before upload. Returns independent batch answers, coverage, usage and a local report. Inspect status and batches for partial failures. Recent identical batches reuse cached answers and their original usage. Text output is capped at 48 KB / 2000 lines; the report preserves the full result.',
    promptSnippet: 'Ask questions about actual audio using a configurable auxiliary model',
    promptGuidelines: [
      'Use audio_understand for questions requiring audio content or atmosphere beyond local signal measurements; include the needed background in question.',
      'Before audio_understand uploads material, obtain external-service and billing consent under the workspace instructions.',
      'Attribute audio_understand findings to the auxiliary model; verify source-time mapping before choosing synchronization points.',
    ],
    exposure: 'direct' as const,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    parameters: {
      type: 'object', additionalProperties: false, required: ['sources', 'question'],
      properties: {
        sources: {
          type: 'array', minItems: 1, maxItems: 250,
          items: {
            type: 'object', additionalProperties: false, required: ['path'],
            properties: {
              path: { type: 'string', minLength: 1, description: 'Local audio path, absolute or relative to the current working directory.' },
              start: { type: 'number', description: 'Inclusive source seconds; defaults to 0. Bounds clamp to [0, source duration]; MP3 cuts may expand outward.' },
              end: { type: 'number', description: 'Exclusive source seconds; defaults to source duration. Bounds clamp to [0, source duration].' },
            },
          },
        },
        question: { type: 'string', minLength: 1, maxLength: 65536, description: 'Question, necessary context and desired answer format. Sent with each batch.' },
      },
    },
    outputSchema: {
      type: 'object', required: ['status', 'batches', 'answer', 'question', 'createdAt', 'endpoint', 'model', 'sources', 'usage', 'warnings', 'cache'],
      properties: {
        status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
        batches: { type: 'array', items: { type: 'object' } },
        answer: { type: 'string' }, question: { type: 'string' }, createdAt: { type: 'string' },
        endpoint: { type: 'string' }, model: { type: 'string' }, responseModel: { type: 'string' }, requestId: { type: 'string' },
        sources: { type: 'array', items: { type: 'object' } },
        usage: { type: ['object', 'null'] }, warnings: { type: 'array', items: { type: 'string' } },
        cache: { type: 'object' },
      },
    },
    async execute(
      _id: string, params: AudioQuestion, signal: AbortSignal | undefined,
      onUpdate: ((result: { content: ReturnType<typeof textBlock>[]; details: undefined }) => void) | undefined,
      ctx: { cwd: string; isProjectTrusted(): boolean },
    ) {
      if (!ctx.isProjectTrusted()) throw new Error('Trust this workspace before using its audio configuration.');
      const result = await understand(params, {
        cwd: ctx.cwd, signal,
        onProgress: (phase) => onUpdate?.({ content: [textBlock(phase)], details: undefined }),
      });
      const fullText = JSON.stringify(result, null, 2);
      const lines = fullText.split('\n').slice(0, 2000).join('\n');
      const text = Buffer.from(lines).subarray(0, 48000).toString('utf8').replace(/\uFFFD$/, '');
      const truncated = text.length < fullText.length;
      return {
        isError: result.status !== 'completed',
        content: [textBlock(text + (truncated ? `\n[Truncated. Full report: ${result.cache.reportPath ?? 'available in structuredContent; local saving failed'}]` : ''))],
        details: { reportPath: result.cache.reportPath, cacheHit: result.cache.hit },
        structuredContent: result,
      };
    },
  };
}

// Plain JSON Schema keeps the adapter loadable by pi and ordinary Node tests without host-only imports.
export default function audioUnderstanding(pi: { registerTool(tool: ReturnType<typeof createTool>): void }) {
  pi.registerTool(createTool(fileURLToPath(new URL('../../../', import.meta.url))));
}
