// The editor step, with a fake `ai` — no API key, no network.
//
// The live test next door asserts "transcribe returns a non-empty string", and
// that is exactly what the bug produced: an apology is a non-empty string. It
// passed for as long as 28% of transcripts were being replaced by one. What
// needed asserting was never the shape of the output but WHOSE text it is.

import { describe, it, expect, beforeEach } from 'vitest'
import * as speech from '../src/speech.js'
import { EDIT } from '../src/speech.js'

const RAW = 'ТЕЛЕФОННИЧЕ СИГНАЛИ Епоем, здравейте. Има записен къс за ваша офис.'
const EDITED = 'Телефонен сигнал. Здравейте. Има записан час за вашия офис.'

// Whatever `object` is set to is what the editor "returns" for the next call.
let object, transcribeResult, warnings

function install({ objectImpl, asr = RAW }) {
  object = objectImpl
  transcribeResult = asr
  return speech.init({
    config: { voip: { language: 'bg-BG', recordsFolder: '/tmp' } },
    ai: {
      transcribe: async () => transcribeResult,
      object: (...args) => object(...args),
      expand: async (c) => c,
    },
    logger: { warn: (...a) => warnings.push(a) },
    context: null,
  })
}

beforeEach(() => { warnings = [] })

describe('the editor decides by a field, not by its prose', () => {
  it('uses the corrected transcript when the editor succeeds', async () => {
    await install({ objectImpl: async () => ({ success: true, transcript: EDITED }) })
    expect(await speech.transcribe('x.mp3')).toBe(EDITED)
  })

  it('keeps the RAW transcript when the editor declines', async () => {
    await install({ objectImpl: async () => ({ success: false, transcript: '' }) })
    expect(await speech.transcribe('x.mp3')).toBe(RAW)
    expect(warnings).toHaveLength(1)
  })

  it('keeps the raw transcript when success is true but nothing came back', async () => {
    // A model can answer the schema and still say nothing useful. `success`
    // alone is not proof there is text to store.
    await install({ objectImpl: async () => ({ success: true, transcript: '   ' }) })
    expect(await speech.transcribe('x.mp3')).toBe(RAW)
  })

  it('keeps the raw transcript when the editor call throws', async () => {
    await install({ objectImpl: async () => { throw new Error('rate limited') } })
    expect(await speech.transcribe('x.mp3')).toBe(RAW)
  })

  it('never stores an apology, in any language', async () => {
    // The five wordings that actually reached production. Each is a REPLY, not a
    // transcript, and each arrives as a successful API call — so only the
    // `success` field can reject them. With prose-sniffing, every one of these
    // needed its own pattern.
    const refusals = [
      'Съжалявам, но няма информация от разговора да се коригира',
      'Съжалявам, не мога да помогна с вашето запитване.',
      'Извинете, няма разпознат текст за транскрипция.',
      'I\'m sorry, but the provided text does not contain any recognizable content.',
      'Извинете, моля предоставете конкретния разговор, който трябва да бъде редактиран.',
    ]
    for (const refusal of refusals) {
      await install({ objectImpl: async () => ({ success: false, transcript: refusal }) })
      const out = await speech.transcribe('x.mp3')
      expect(out).toBe(RAW)
      expect(out).not.toContain('Съжалявам')
      expect(out).not.toContain('sorry')
    }
  })

  it('keeps every schema field required — optional fields are a 400 from OpenAI', () => {
    // A fake `ai` cannot catch this: it never validates the schema the way the
    // provider does. `z.string().default('')` reads as harmless and makes the
    // field OPTIONAL in the generated JSON Schema, which strict structured
    // output rejects — "'required' must include every key in properties" — on
    // every call. It fails silently end to end: ai.object throws, the catch
    // returns the raw transcript, and the output looks right while the editor
    // never runs. Caught only by a live call, so assert the shape here instead.
    for (const [name, field] of Object.entries(EDIT.shape)) {
      expect(field.isOptional(), `${name} must not be optional`).toBe(false)
    }
  })

  it('does not call the editor at all when the ASR returned nothing', async () => {
    let called = false
    await install({ objectImpl: async () => { called = true; return { success: true, transcript: 'x' } }, asr: '' })
    expect(await speech.transcribe('x.mp3')).toBe('')
    expect(called).toBe(false)
  })
})
