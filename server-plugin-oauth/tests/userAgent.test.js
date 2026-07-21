import { describe, it, expect } from 'vitest'
import { parseUserAgent } from '../src/userAgent.js'

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
}

describe('parseUserAgent — best-effort, display-only', () => {
  it('distinguishes Chrome from Safari on the same OS (both contain "Safari/")', () => {
    expect(parseUserAgent(UA.chromeMac)).toEqual({ browser: 'Chrome', os: 'macOS' })
    expect(parseUserAgent(UA.safariMac)).toEqual({ browser: 'Safari', os: 'macOS' })
  })

  it('Edge is not misidentified as Chrome, even though its UA contains "Chrome/"', () => {
    expect(parseUserAgent(UA.edgeWindows)).toEqual({ browser: 'Edge', os: 'Windows' })
  })

  it('handles Firefox/Linux, Android, and iOS variants', () => {
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({ browser: 'Firefox', os: 'Linux' })
    expect(parseUserAgent(UA.chromeAndroid)).toEqual({ browser: 'Chrome', os: 'Android' })
    expect(parseUserAgent(UA.safariIos)).toEqual({ browser: 'Safari', os: 'iOS' })
    expect(parseUserAgent(UA.chromeIos)).toEqual({ browser: 'Chrome', os: 'iOS' })
  })

  it('falls back to Unknown/Unknown for missing or unrecognized input', () => {
    expect(parseUserAgent(undefined)).toEqual({ browser: 'Unknown', os: 'Unknown' })
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown', os: 'Unknown' })
    expect(parseUserAgent('curl/8.4.0')).toEqual({ browser: 'Unknown', os: 'Unknown' })
  })
})
