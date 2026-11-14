/**
 * whisper.cpp emits bracketed markers for non-speech audio and pads its output
 * with blank lines. None of that belongs in a step card, and the author should
 * never have to delete it by hand.
 *
 * The segment-limit alert is a short tone rather than spoken words precisely so
 * that it needs no special handling here: whisper renders a beep as one of the
 * non-speech markers below, or as nothing at all.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[(BLANK_AUDIO|SOUND|MUSIC|NOISE|INAUDIBLE|BEEP|BELL|DING)[^\]]*\]/gi, ' ')
    .replace(/\((?:blank audio|silence|inaudible|beep|beeping)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Filler words the author almost never wants in a finished guide.
 * Applied only on explicit request from the storyboard, never automatically -
 * silently rewriting what someone said is a good way to lose their trust.
 */
const FILLERS = /\b(?:um+|uh+|erm+|ah+|like|you know|sort of|kind of|basically|actually|so yeah)\b/gi

export function stripFillers(text: string): string {
  return text
    .replace(FILLERS, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+/, '')
    .trim()
}
