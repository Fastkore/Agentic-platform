import { readFile } from 'node:fs/promises';
import type { DictationModelId, DictationModels } from '../shared/types.js';
import { BridgeError } from './store.js';

export const maxDictationBytes = 44 + 62 * 16_000 * 2;
export type TranscribeDictation = (audio: Buffer) => Promise<string>;

interface DictationService {
  transcribe: TranscribeDictation;
  models: (change?: { id: DictationModelId; action: 'download' | 'select' }) => Promise<DictationModels | null>;
}

export function validateDictation(audio: Buffer) {
  if (audio.length <= 44 || audio.length > maxDictationBytes || audio.length % 2 !== 0
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.readUInt32LE(4) !== audio.length - 8
    || audio.toString('ascii', 8, 16) !== 'WAVEfmt ' || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16_000
    || audio.readUInt32LE(28) !== 32_000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44) {
    throw new BridgeError('Запишите короткую фразу с микрофона и попробуйте снова.');
  }
}

export async function loadDictation(): Promise<DictationService | undefined> {
  if (!process.env.BRIDGE_DICTATION_URL) return;
  const url = new URL(process.env.BRIDGE_DICTATION_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/transcriptions') {
    throw new Error('BRIDGE_DICTATION_URL должен указывать на /transcriptions сервиса распознавания.');
  }
  const file = process.env.BRIDGE_DICTATION_TOKEN_FILE;
  const token = file && (await readFile(file, 'utf8')).trim();
  if (!token || /\s/.test(token)) throw new Error('Не задан токен сервиса распознавания речи.');

  const headers = { Authorization: 'Bearer ' + token };
  const transcribe: TranscribeDictation = async audio => {
    const data = new FormData();
    data.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'dictation.wav');
    data.append('asr_backend', 'faster_whisper');
    data.append('diarization_backend', 'none');
    const signal = AbortSignal.timeout(120_000);
    try {
      const response = await fetch(url, { method: 'POST', headers, body: data, redirect: 'error', signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BridgeError('Сервис распознавания не обработал запись. Попробуйте ещё раз.', 502);
      }
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== 'string' || result.text.length > 60_000) throw new Error('Unexpected dictation response');
      return result.text.trim();
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (signal.aborted) throw new BridgeError('Распознавание заняло слишком много времени. Попробуйте более короткую фразу.', 504);
      throw new BridgeError('Сервис распознавания речи недоступен.', 502);
    }
  };
  return {
    transcribe,
    async models(change) {
      const route = '/agent-platform/models' + (change ? `/${change.id}/${change.action}` : '');
      try {
        const response = await fetch(new URL(route, url), { method: change ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(8_000) });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 404 && !change) return null;
          if (response.status === 409) throw new BridgeError('Дождитесь завершения загрузки модели или сначала скачайте её.', 409);
          throw new BridgeError('Сервис распознавания не подтвердил операцию с моделью.', 502);
        }
        const state = await response.json() as DictationModels;
        if (!Array.isArray(state.models)) throw new Error('Unexpected model response');
        return state;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('Сервис распознавания речи недоступен.', 502);
      }
    },
  };
}
