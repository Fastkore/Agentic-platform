import { useEffect, useRef, useState } from 'react';
import { ArrowUp, LoaderCircle, Mic, Square, X } from 'lucide-react';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
const recordingLimitMs = 60_000;
const sampleRate = 16_000;
const idleLevels = Array<number>(32).fill(0.08);

function monitorAudio(stream: MediaStream, onLevel: (level: number) => void) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  void context.resume().catch(() => {});
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0, lastSample = 0;
  const measure = (now: number) => {
    if (now - lastSample >= 60) {
      lastSample = now;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      onLevel(Math.min(1, 0.08 + 4 * Math.sqrt(energy / samples.length)));
    }
    frame = requestAnimationFrame(measure);
  };
  frame = requestAnimationFrame(measure);
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    void context.close().catch(() => {});
  };
}

async function encodeWav(recording: Blob) {
  const context = new AudioContext({ sampleRate });
  try {
    const audio = await context.decodeAudioData(await recording.arrayBuffer());
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    const samples = Math.min(audio.length, sampleRate * 60);
    const wav = new ArrayBuffer(44 + samples * 2), view = new DataView(wav);
    const write = (offset: number, text: string) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true);
    write(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      const value = Math.max(-1, Math.min(1, sum / channels.length));
      view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    return new Blob([wav], { type: 'audio/wav' });
  } finally {
    await context.close();
  }
}

export function VoiceDictation({ transcribe, onText, onError, canSend }: {
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  onText: (text: string, send: boolean) => void;
  onError: (error: unknown) => void;
  canSend: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [levels, setLevels] = useState(idleLevels);
  const operation = useRef<AbortController | null>(null);
  const recording = useRef<MediaRecorder | null>(null);
  const sendAfterRecording = useRef(false);
  const insertText = useRef(onText);
  insertText.current = onText;
  useEffect(() => () => operation.current?.abort(), []);

  async function record() {
    if (operation.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      onError(new Error('Диктовка недоступна в этом браузере.'));
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    const { signal } = controller;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopMeter: (() => void) | undefined;
    sendAfterRecording.current = false;
    setLevels(idleLevels);
    setPhase('starting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      if (signal.aborted) return;
      const recorder = new MediaRecorder(stream);
      recording.current = recorder;
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
      try { stopMeter = monitorAudio(stream, level => setLevels(old => [...old.slice(1), level])); }
      catch { /* A missing level meter does not interrupt recording. */ }
      const audio = await new Promise<Blob>((resolve, reject) => {
        const chunks: Blob[] = [];
        recorder.addEventListener('dataavailable', e => { if (e.data.size) chunks.push(e.data); });
        recorder.addEventListener('error', () => reject(new Error('Микрофон прервал запись.')), { once: true });
        recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true });
        signal.addEventListener('abort', stop, { once: true });
        recorder.start();
        timer = setTimeout(stop, recordingLimitMs);
        setPhase('recording');
      });
      stopMeter?.();
      stopMeter = undefined;
      stream.getTracks().forEach(track => track.stop());
      if (signal.aborted) return;
      if (!audio.size) throw new Error('Запись получилась пустой.');
      setPhase('transcribing');
      const wav = await encodeWav(audio);
      if (signal.aborted) return;
      const text = await transcribe(wav, signal);
      if (!signal.aborted) {
        if (!text.trim()) throw new Error('Речь не распознана. Попробуйте сказать ещё раз.');
        insertText.current(text, sendAfterRecording.current);
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') onError(new Error('Разрешите доступ к микрофону, чтобы начать диктовку.'));
        else if (error instanceof DOMException && error.name === 'NotFoundError') onError(new Error('Микрофон не найден.'));
        else onError(error);
      }
    } finally {
      clearTimeout(timer);
      stopMeter?.();
      stream?.getTracks().forEach(track => track.stop());
      recording.current = null;
      operation.current = null;
      if (!signal.aborted) setPhase('idle');
    }
  }

  function finish(send: boolean) {
    if (recording.current?.state !== 'recording') return;
    sendAfterRecording.current = send;
    recording.current.stop();
    setPhase('transcribing');
  }

  if (phase === 'recording' || phase === 'transcribing') return <div className="dictation-strip">
    <button type="button" className="workspace-icon" aria-label="Отменить диктовку" title="Отменить диктовку" onClick={() => {
      operation.current?.abort();
      setPhase('idle');
    }}><X size={17} /></button>
    {phase === 'recording' ? <div className="dictation-wave" role="img" aria-label="Идёт запись">
      {levels.map((level, i) => <span key={i} style={{ height: Math.round(level * 25) + 'px' }} />)}
    </div> : <span className="dictation-status" role="status"><LoaderCircle size={16} className="spin" />Распознаём речь…</span>}
    {phase === 'recording' && <>
      <button type="button" className="workspace-icon dictation-stop" aria-label="Остановить запись" title="Остановить запись" onClick={() => finish(false)}><Square size={14} /></button>
      <button type="button" className="bridge-send" aria-label="Отправить диктовку" title="Распознать и отправить" disabled={!canSend} onClick={() => finish(true)}><ArrowUp size={18} /></button>
    </>}
  </div>;

  const label = phase === 'starting' ? 'Включаем микрофон…' : 'Диктовка';
  return <button type="button" className="workspace-icon dictation-button" aria-label={label} title={label} disabled={phase === 'starting'} onClick={() => void record()}>
    {phase === 'idle' ? <Mic size={17} /> : <LoaderCircle size={17} className="spin" />}
  </button>;
}
