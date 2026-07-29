// Best-effort, display-only User-Agent parsing for the login-history list —
// never used for anything security- or auth-relevant. A dedicated parsing
// package is overkill for "Chrome on macOS"; a small ordered pattern table
// (most-specific first, so e.g. Edge/Opera/mobile-Chrome match before the
// generic Chrome/Firefox fallback they'd otherwise also satisfy) is enough.

const BROWSER_PATTERNS = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/CriOS\//, 'Chrome'],    // Chrome on iOS
  [/FxiOS\//, 'Firefox'],   // Firefox on iOS
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Version\/.*Safari\//, 'Safari'],   // Chrome's UA also has "Safari/" but never "Version/…Safari/"
]

const OS_PATTERNS = [
  [/Windows NT/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Android/, 'Android'],
  [/Linux/, 'Linux'],
]

export function parseUserAgent(ua) {
  if (!ua) return { browser: 'Unknown', os: 'Unknown' }
  const browser = BROWSER_PATTERNS.find(([re]) => re.test(ua))?.[1] || 'Unknown'
  const os = OS_PATTERNS.find(([re]) => re.test(ua))?.[1] || 'Unknown'
  return { browser, os }
}
