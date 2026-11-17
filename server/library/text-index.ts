/**
 * Pure text indexing of one file: encoding detection, UTF-8 validation, line offsets, search chunks and document sections (pages, sheets, headings).
 * Runs inside the index worker (index-worker.ts) so that a pathological file can be interrupted from the outside.
 */
export const linesPerChunk = 40, chunkChars = 12_000, lineIndexStep = 200, maxIndexedLineChars = 4000;

type Decoded = { encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be'; bomBytes: number };
export function detectEncoding(head: Uint8Array): Decoded | 'binary' {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8-bom', bomBytes: 3 };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bomBytes: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bomBytes: 2 };
  if (head.subarray(0, 8192).includes(0)) return 'binary';
  return { encoding: 'utf-8', bomBytes: 0 };
}


export interface TextIndexInput {
  data: Uint8Array;
  /** object: the stored original (encoding detected here); derived: UTF-8 text extracted from a document. */
  mode: 'object' | 'derived';
  /** Full-text indexing stops after this many bytes; line offsets continue. */
  indexTextBytes: number;
}
export interface TextIndexResult {
  state: 'indexed' | 'limited' | 'unsupported_format' | 'unsupported_encoding';
  encoding?: string; mediaType?: string; lines?: number; note?: string;
  /** [startLine, text] */ chunks: [number, string][];
  /** [line, byteOffset] every lineIndexStep lines; offsets refer to the original object, or to `derived` when present. */ offsets: [number, number][];
  /** [line, label]: pages, sheets and headings of extracted documents, for citations. */ sections: [number, string][];
  /** UTF-8 text to store as a derived object (UTF-16 originals). */ derived?: Uint8Array;
}

/** Section markers written by the document extractors: "# Страница 3", "# Лист: Цены · строк 40", "## Заголовок". */
const sectionMarker = /^#{1,3} (.{1,200}?)(?: · строк \d+)?$/;
function writer(trackSections: boolean) {
  const chunks: [number, string][] = [], offsets: [number, number][] = [], sections: [number, string][] = [];
  let line = 0, chunkStart = 1, buffer: string[] = [], size = 0;
  const flush = () => {
    if (!buffer.length) return;
    chunks.push([chunkStart, buffer.join('\n')]);
    buffer = []; size = 0; chunkStart = line + 1;
  };
  return {
    chunks, offsets, sections,
    line(text: string, offset: number, skipIndex = false) {
      line++;
      const clean = text.endsWith('\r') ? text.slice(0, -1) : text;
      if ((line - 1) % lineIndexStep === 0) offsets.push([line, offset]);
      if (skipIndex) { flush(); chunkStart = line + 1; return; }
      if (!buffer.length) chunkStart = line;
      buffer.push(clean.length > maxIndexedLineChars ? clean.slice(0, maxIndexedLineChars) : clean);
      size += Math.min(clean.length, maxIndexedLineChars);
      if (trackSections) { const marker = sectionMarker.exec(clean); if (marker) sections.push([line, marker[1]]); }
      if (buffer.length >= linesPerChunk || size >= chunkChars) flush();
    },
    finish() { flush(); return line; },
  };
}

const decoder = new TextDecoder('utf-8');
/** Splits UTF-8 bytes into lines starting at `from`; offsets are positions in `data`. */
function indexLines(data: Uint8Array, from: number, trackSections: boolean, limitBytes: number) {
  const w = writer(trackSections);
  let start = from, indexed = 0, limited = false;
  for (let i = data.indexOf(0x0a, start); i >= 0; i = data.indexOf(0x0a, start)) {
    indexed += i - start + 1;
    if (indexed > limitBytes) limited = true;
    w.line(decoder.decode(data.subarray(start, i)), start, limited);
    start = i + 1;
  }
  if (start < data.length) w.line(decoder.decode(data.subarray(start)), start, limited);
  return { lines: w.finish(), chunks: w.chunks, offsets: w.offsets, sections: w.sections, limited };
}

export function indexBytes(input: TextIndexInput): TextIndexResult {
  const empty = { chunks: [], offsets: [], sections: [] };
  const { data } = input;
  if (input.mode === 'derived') {
    const r = indexLines(data, 0, true, Number.POSITIVE_INFINITY);
    return { state: 'indexed', lines: r.lines, chunks: r.chunks, offsets: r.offsets, sections: r.sections };
  }
  const detected = detectEncoding(data.subarray(0, 8192));
  if (detected === 'binary') return { state: 'unsupported_format', note: 'Файл содержит двоичные данные', ...empty };
  if (detected.encoding === 'utf-16le' || detected.encoding === 'utf-16be') {
    if (data.length > input.indexTextBytes * 2) return { state: 'unsupported_format', encoding: detected.encoding, note: 'UTF-16 файл превышает предел извлечения', ...empty };
    let text: string;
    try { text = new TextDecoder(detected.encoding, { fatal: true }).decode(data.subarray(detected.bomBytes)); }
    catch { return { state: 'unsupported_encoding', encoding: detected.encoding, note: 'Некорректная последовательность UTF-16', ...empty }; }
    const derived = new TextEncoder().encode(text);
    const r = indexLines(derived, 0, false, Number.POSITIVE_INFINITY);
    return { state: 'indexed', encoding: detected.encoding, mediaType: 'text/plain', lines: r.lines, chunks: r.chunks, offsets: r.offsets, sections: r.sections, derived };
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(detected.bomBytes)); }
  catch { return { state: 'unsupported_encoding', encoding: 'unknown', note: 'Файл не является корректным UTF-8. Укажите кодировку явно или преобразуйте файл.', ...empty }; }
  const r = indexLines(data, detected.bomBytes, false, input.indexTextBytes);
  return { state: r.limited ? 'limited' : 'indexed', encoding: detected.encoding, mediaType: 'text/plain', lines: r.lines, chunks: r.chunks, offsets: r.offsets, sections: r.sections,
    note: r.limited ? `Полнотекстовый индекс ограничен первыми ${Math.round(input.indexTextBytes / 1048576)} МиБ; чтение строк доступно полностью.` : undefined };
}
