import { XMLParser } from 'fast-xml-parser';

/**
 * Converts broadcaster subtitle files to WebVTT.
 *
 * Browsers only accept WebVTT in a <track> element, but the Filmliste `url_subtitle` values are
 * mostly TTML/EBU-TT-D (ARD, ZDF) with the occasional SRT or VTT. Everything is normalised here so
 * the player can treat captions uniformly.
 */

const TTML_TIME_CLOCK = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;
const TTML_TIME_FRAMES = /^(\d+):(\d{2}):(\d{2}):(\d{1,3})$/;
const TTML_TIME_OFFSET = /^([\d.]+)(h|m|s|ms|f|t)$/;

const SRT_TIMECODE = /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

const DEFAULT_FRAME_RATE = 25;

/** Broadcast-escaped line breaks, e.g. ORF writes `&lt;br/&gt;` into the text instead of a <br/> element. */
const ESCAPED_LINE_BREAK = /<br\s*\/?>/gi;

/** How far the last cue may run past the end of the video before its timing is considered off. */
const DURATION_TOLERANCE_SECONDS = 60;

type Cue = { start: number, end: number, text: string };

export class SubtitleConversionError extends Error { }

export type ToWebVttOptions = {
  /** Duration of the video in seconds, used to tell a timecode offset apart from a long programme. */
  videoDuration?: number
};

/** Formats seconds as the `HH:MM:SS.mmm` timestamp WebVTT expects. */
function formatTimestamp(totalSeconds: number): string {
  // Rounded once up front so a value like 2.9996 becomes 3.000 rather than 2.1000.
  const totalMilliseconds = Math.round(Math.max(0, totalSeconds) * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
  const milliseconds = totalMilliseconds % 1000;

  const pad = (value: number, length = 2) => value.toString().padStart(length, '0');

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

/** Parses a TTML time expression (clock, frame or offset form) into seconds. */
function parseTtmlTime(value: string, frameRate: number): number | null {
  const trimmed = value.trim();

  const frames = TTML_TIME_FRAMES.exec(trimmed);

  if (frames != null) {
    const [, hours, minutes, seconds, frame] = frames;
    return (Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds) + (Number(frame) / frameRate);
  }

  const clock = TTML_TIME_CLOCK.exec(trimmed);

  if (clock != null) {
    const [, hours, minutes, seconds, fraction] = clock;
    const fractionSeconds = (fraction != undefined) ? Number(`0.${fraction}`) : 0;

    return (Number(hours ?? 0) * 3600) + (Number(minutes) * 60) + Number(seconds) + fractionSeconds;
  }

  const offset = TTML_TIME_OFFSET.exec(trimmed);

  if (offset != null) {
    const amount = Number(offset[1]);

    switch (offset[2]) {
      case 'h': return amount * 3600;
      case 'm': return amount * 60;
      case 's': return amount;
      case 'ms': return amount / 1000;
      case 'f': return amount / frameRate;
      default: return null;
    }
  }

  return null;
}

/**
 * A node as produced by fast-xml-parser in `preserveOrder` mode: exactly one tag key holding an
 * ordered child list (or `#text` holding a string), plus an optional `:@` attribute bag.
 */
type OrderedNode = Record<string, any>;

function childrenOf(node: OrderedNode, tagName: string): OrderedNode[] {
  const value = node[tagName];

  return Array.isArray(value) ? value : [];
}

function tagNameOf(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key != ':@') {
      return key;
    }
  }

  return null;
}

/** Collects every <p> under a node, however deeply the document nests its <div>s. */
function collectParagraphs(nodes: OrderedNode[], found: OrderedNode[]): void {
  for (const node of nodes) {
    const tagName = tagNameOf(node);

    if (tagName == null) {
      continue;
    }

    if (tagName == 'p') {
      found.push(node);
      continue;
    }

    if (tagName != '#text') {
      collectParagraphs(childrenOf(node, tagName), found);
    }
  }
}

/**
 * Flattens the ordered content of a TTML <p> into plain text, turning <br/> into a newline and
 * inlining any nested <span>. Document order matters here, which is why the parser runs in
 * `preserveOrder` mode: without it a <br/> between two text runs loses its position.
 */
function collectText(nodes: OrderedNode[], parts: string[]): void {
  for (const node of nodes) {
    const tagName = tagNameOf(node);

    if (tagName == null) {
      continue;
    }

    if (tagName == '#text') {
      parts.push(String(node['#text'] ?? '').replace(ESCAPED_LINE_BREAK, '\n'));
      continue;
    }

    if (tagName == 'br') {
      parts.push('\n');
      continue;
    }

    collectText(childrenOf(node, tagName), parts);
  }
}

/** WebVTT gives `-->` and `<` special meaning inside cue payloads. */
function sanitizeCueText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/-->/g, '--→')
    .replace(/</g, '&lt;')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    // A cue must not contain a blank line - that would terminate it early.
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Removes a broadcast timecode offset.
 *
 * Studio subtitle files follow the SMPTE convention of starting the programme at 10:00:00:00 rather
 * than at zero, and several ARD broadcasters (SR, ARD-alpha, and some BR and HR programmes) publish
 * them unchanged. Played against a video starting at zero, such cues would first appear ten hours
 * in - that is, never. The offset is rounded to whole hours so pre-roll cues from 09:59:xx still
 * resolve to a 10 h offset, and it is only removed when the cues would otherwise overrun the video.
 */
function removeTimecodeOffset(cues: Cue[], videoDuration: number | undefined): Cue[] {
  if (cues.length == 0) {
    return cues;
  }

  const earliestStart = Math.min(...cues.map((cue) => cue.start));
  const latestEnd = Math.max(...cues.map((cue) => cue.end));
  const offsetHours = Math.round(earliestStart / 3600);

  if (offsetHours < 1) {
    return cues;
  }

  const fitsVideo = (videoDuration != undefined) && (videoDuration > 0) && (latestEnd <= videoDuration + DURATION_TOLERANCE_SECONDS);

  if (fitsVideo) {
    return cues;
  }

  const offset = offsetHours * 3600;

  return cues
    .map((cue) => ({ ...cue, start: Math.max(0, cue.start - offset), end: cue.end - offset }))
    .filter((cue) => cue.end > 0);
}

function cuesToWebVtt(cues: Cue[]): string {
  const blocks = cues
    .filter((cue) => (cue.text.length > 0) && (cue.end > cue.start))
    .map((cue) => `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`);

  if (blocks.length == 0) {
    throw new SubtitleConversionError('subtitle contains no usable cues');
  }

  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

function parseTtml(body: string): Cue[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Element names are namespace prefixed in EBU-TT-D (tt:p, tt:div, ...); strip the prefix so a
    // single traversal handles both prefixed and unprefixed documents.
    removeNSPrefix: true,
    // Keeps mixed content in document order, so a <br/> between two text runs stays put.
    preserveOrder: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false
  });

  let document: OrderedNode[];

  try {
    document = parser.parse(body) as OrderedNode[];
  }
  catch (error) {
    throw new SubtitleConversionError(`could not parse TTML: ${(error as Error).message}`);
  }

  const ttNode = (Array.isArray(document) ? document : []).find((node) => node['tt'] != undefined);

  if (ttNode == undefined) {
    throw new SubtitleConversionError('TTML document has no <tt> root');
  }

  const frameRate = Number(ttNode[':@']?.['@_frameRate']) || DEFAULT_FRAME_RATE;

  const paragraphs: OrderedNode[] = [];

  for (const child of childrenOf(ttNode, 'tt')) {
    if (tagNameOf(child) == 'body') {
      collectParagraphs(childrenOf(child, 'body'), paragraphs);
    }
  }

  const cues: Cue[] = [];

  for (const paragraph of paragraphs) {
    const attributes = paragraph[':@'] ?? {};
    const begin = attributes['@_begin'];
    const end = attributes['@_end'];
    const duration = attributes['@_dur'];

    if (typeof begin != 'string') {
      continue;
    }

    const start = parseTtmlTime(begin, frameRate);

    if (start == null) {
      continue;
    }

    let stop: number | null = null;

    if (typeof end == 'string') {
      stop = parseTtmlTime(end, frameRate);
    }
    else if (typeof duration == 'string') {
      const parsedDuration = parseTtmlTime(duration, frameRate);
      stop = (parsedDuration == null) ? null : (start + parsedDuration);
    }

    if (stop == null) {
      continue;
    }

    const parts: string[] = [];
    collectText(childrenOf(paragraph, 'p'), parts);

    cues.push({ start, end: stop, text: sanitizeCueText(parts.join('')) });
  }

  return cues;
}

function parseSrt(body: string): Cue[] {
  const cues: Cue[] = [];

  for (const block of body.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
      continue;
    }

    const timecodeIndex = lines.findIndex((line) => SRT_TIMECODE.test(line));

    if (timecodeIndex < 0) {
      continue;
    }

    const match = SRT_TIMECODE.exec(lines[timecodeIndex])!;
    const toSeconds = (hours: string, minutes: string, seconds: string, milliseconds: string) =>
      (Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds) + (Number(milliseconds.padEnd(3, '0')) / 1000);

    cues.push({
      start: toSeconds(match[1], match[2], match[3], match[4]),
      end: toSeconds(match[5], match[6], match[7], match[8]),
      text: sanitizeCueText(lines.slice(timecodeIndex + 1).join('\n'))
    });
  }

  return cues;
}

/** Normalises an already-WebVTT file: strip a BOM and make sure the magic header is present. */
function normalizeWebVtt(body: string): string {
  const withoutBom = body.replace(/^﻿/, '');

  return withoutBom.startsWith('WEBVTT') ? withoutBom : `WEBVTT\n\n${withoutBom}`;
}

/**
 * Converts a subtitle file of any supported format to WebVTT.
 *
 * @throws {SubtitleConversionError} when the format is unrecognised or yields no usable cues.
 */
export function toWebVtt(body: string, options: ToWebVttOptions = {}): string {
  const sample = body.replace(/^﻿/, '').trimStart();

  if (sample.length == 0) {
    throw new SubtitleConversionError('subtitle is empty');
  }

  if (sample.startsWith('WEBVTT')) {
    return normalizeWebVtt(body);
  }

  let cues: Cue[];

  if (sample.startsWith('<')) {
    cues = parseTtml(sample);
  }
  else if (SRT_TIMECODE.test(sample)) {
    cues = parseSrt(sample);
  }
  else {
    throw new SubtitleConversionError('unrecognized subtitle format');
  }

  return cuesToWebVtt(removeTimecodeOffset(cues, options.videoDuration));
}
