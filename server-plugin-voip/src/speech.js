import path from 'path'
import { z } from 'zod'

let language, recordsFolder, ai, logger, context
let business = null

// The editor answers in a structured shape, not prose, because its failure mode
// is to REPLY rather than to throw. Asked for "only the corrected transcript, no
// commentary" it would answer a transcript it could not read with a sentence —
// "Извинете, моля предоставете конкретния разговор" — and that sentence was
// returned as the transcript and stored. 16 of 57 calls (28%) lost a transcript
// that Whisper had produced correctly; the raw text was discarded in favour of an
// apology, and nothing downstream could tell the difference because an apology is
// non-empty text in the right language.
//
// `success` moves that judgement from our guesswork to the model's own answer.
// Sniffing the prose for refusal phrases was the alternative and it is a losing
// game: the refusals arrived in Bulgarian and English, as apology, as request for
// input, and as statement of absence, and any pattern list is one unseen wording
// away from failing the same way again.
// Both fields REQUIRED, and no `.default()` on either. A default makes the field
// optional in the generated JSON Schema, and OpenAI's strict structured-output
// mode rejects a schema whose `required` does not list every property —
// "Missing 'transcript'", HTTP 400, on every single call. That failure is quiet
// in the worst way: ai.object throws, the catch below returns the raw transcript,
// and the output looks correct while the editor never runs at all.
export const EDIT = z.object({
  success: z.boolean(),
  transcript: z.string(),
})

// How much of the input an edit has to keep to still count as one. Correcting
// spelling and recognition errors moves the length by a few percent either way;
// half is far outside that, and the case this exists for lost 99.7% — 2,076
// characters returned as 6. Deliberately loose: the point is to catch the
// transcript being replaced by something else, not to police wording.
const RETAINED_MIN = 0.5

export async function init(deps) {
  language = deps.config.voip.language
  recordsFolder = deps.config.voip.recordsFolder
  ai = deps.ai
  logger = deps.logger
  context = deps.context
  business = context ? await ai.expand(context) : null
}

function buildPrompt() {
  return [
    'Phone call between a customer and a company representative.',
    context || '',
  ].filter(Boolean).join(' ').slice(0, 800)
}

export async function transcribe(filename) {
  const localPath = path.join(recordsFolder, filename)
  const lang = language?.split('-')[0]

  const text = await ai.transcribe(localPath, { language: lang, prompt: buildPrompt() })

  if (!text) return text

  const normalized = await normalize(text).catch(err => {
    logger.warn({ err }, 'Transcription normalization failed')
    return text
  })
  return normalized
}

async function normalize(transcript) {
  const system = [
    'You are a transcription editor.',
    business ? `Context about the business:\n${business}` : '',
    'You will receive a raw phone call transcript between two people.',
    'Fix spelling of names, products, and terms specific to this business.',
    'Correct obvious speech recognition errors. Keep the meaning intact as much as possible.',
    'Set success=true and return the corrected transcript in `transcript`.',
    'If the input is not a usable transcript — empty, unintelligible, or not speech —',
    'set success=false and leave `transcript` empty.',
    'Never put an explanation, apology or request in `transcript`.',
  ].filter(Boolean).join('\n')

  const result = await ai.object(system, transcript, EDIT)

  // Falling back to the RAW transcript, never to nothing. Whisper's output is
  // the conversation — garbled, but readable and worth keeping. Every call this
  // path has fired on had a perfectly usable raw transcript behind whatever
  // replaced it.
  const edited = result?.success ? result.transcript?.trim() : ''
  if (!edited) {
    logger.warn(
      { chars: transcript.length, declined: result?.success === false },
      'Transcription editor returned no usable text; keeping the raw transcript',
    )
    return transcript
  }

  // An edit that deletes most of the transcript is not an edit, whatever the
  // model says about it. `success` catches the model announcing it cannot do the
  // job; it cannot catch the model doing the job destructively and reporting
  // success — and that happened. One 227-second call reached this function as
  // 2,076 characters of conversation and left it as the single word "Звънец":
  // the editor took the "ТЕЛЕФОННО ЗВОНИТ" that Whisper puts at the head of a
  // noisy recording, decided that was the content, and returned it alone. Stored
  // for two days as that call's transcript, with success=true.
  //
  // This is a check on the OPERATION, not a guess at the meaning. Correcting
  // spelling and recognition errors moves the length a little in either
  // direction; losing half of it means the text that came back is not the text
  // that went in, and no reading of the prose is needed to know that.
  if (edited.length < transcript.length * RETAINED_MIN) {
    logger.warn(
      { from: transcript.length, to: edited.length },
      'Transcription editor returned a fraction of the input; keeping the raw transcript',
    )
    return transcript
  }
  return edited
}
