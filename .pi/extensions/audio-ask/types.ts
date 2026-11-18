import type { Attempt, ModelAnswer } from './audio-api.ts';
import type { AudioSource, SourceRecord } from './media.ts';

export type AudioItem = { label?: string; sources: AudioSource[] };
export type AskRequest = { title: string; question: string; allowContinuation?: boolean } & (
  { sources: AudioSource[]; continueFrom?: never } | { continueFrom: string; sources?: never }
);
export type BatchRequest = { title: string; question: string; items: AudioItem[] };
export type ItemRecord = AudioItem & {
  id: string;
  status: 'pending' | 'ready' | 'completed' | 'failed';
  prepared: SourceRecord[];
  error?: string;
};
export type BatchRecord = Partial<ModelAnswer> & {
  id: string; itemIds: string[]; encodedAudioBytes: number;
  status: 'running' | 'completed' | 'failed'; attempts: Attempt[]; error?: string;
};
export type Consultation = {
  version: 1; id: string; title: string; question: string; mode: 'ask' | 'batch';
  createdAt: string; updatedAt: string;
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  endpoint: string; model: string; api: 'openai-completions' | 'openai-responses'; requestParams: Record<string, unknown>;
  items: ItemRecord[]; batches: BatchRecord[]; warnings: string[];
  allowContinuation?: boolean;
  continuation?: { id: string; recordPath: string };
};
export type ArchiveState = { recordPath: string; reportPath: string; recordSaved: boolean; saved: boolean; error?: string };
export type AskResult = { consultation: Consultation; archive: ArchiveState };
