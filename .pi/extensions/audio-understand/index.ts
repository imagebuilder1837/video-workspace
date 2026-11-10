import { fileURLToPath } from 'node:url';
import { createAudioUnderstanding } from './understand.ts';
import type { AudioQuestion } from './understand.ts';

const textBlock = (text: string) => ({ type: 'text' as const, text });

function createTool(workspaceRoot: string) {
  const understand = createAudioUnderstanding(workspaceRoot);
  return {
    name: 'audio_understand',
    label: 'Audio understanding',
    description: 'Ask a configurable audio-capable Chat Completions model a free-form question about local audio files or explicit source-time ranges. Sends the audio and question to the configured service and may incur charges; the main agent handles user consent. Sources are identified as source-1, source-2, etc. Returns model text, source/clip mapping, transformations, reported token usage and a local report path. Model timings are approximate. Identical recent requests reuse local answers; usage on cache hits belongs to the original request. Text output is limited to 48 KB / 2000 lines; the report preserves the full answer.',
    promptSnippet: 'Ask questions about actual audio using a configurable auxiliary model',
    promptGuidelines: [
      'Use audio_understand for questions requiring audio content or atmosphere beyond local signal measurements; include the needed background in question.',
      'Before audio_understand uploads material, handle external-service and billing consent under the workspace instructions.',
      'Attribute audio_understand findings to the auxiliary model; verify its time basis against the returned source ranges before choosing synchronization points.',
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
              start: { type: 'number', minimum: 0, description: 'Inclusive start in source seconds; defaults to 0.' },
              end: { type: 'number', minimum: 0, description: 'Exclusive end in source seconds; defaults to source duration.' },
            },
          },
        },
        question: { type: 'string', minLength: 1, maxLength: 65536, description: 'Free-form question, necessary context and desired answer format. Only this text and the listed audio are sent.' },
      },
    },
    outputSchema: {
      type: 'object', required: ['answer', 'question', 'createdAt', 'endpoint', 'model', 'sources', 'usage', 'warnings', 'cache'],
      properties: {
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
