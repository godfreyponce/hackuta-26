import pino from 'pino';

export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  '*.phoneE164', 'phoneE164', '*.*.phoneE164',
  '*.token', 'token', '*.participant_token', 'participant_token',
  '*.apiKey', 'apiKey', '*.key', 'key',
  '*.ANTHROPIC_API_KEY', '*.GEMINI_API_KEY', '*.STABILITY_API_KEY', '*.LIVEKIT_API_SECRET',
  '*.MONGODB_URI', '*.AGENT_SHARED_SECRET',
];

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[redacted]' },
});

/** "+15551234567" → "+1•••••4567" */
export function maskPhone(e164: string): string {
  if (e164.length < 6) return '•••';
  const cc = e164.startsWith('+1') ? '+1' : e164.slice(0, 3);
  return `${cc}•••••${e164.slice(-4)}`;
}

/** Strip anything that looks like a key or query secret from a URL/string before logging. */
export function scrub(s: string): string {
  return s
    .replace(/(key|token|secret)=[^&\s]+/gi, '$1=[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/mongodb(\+srv)?:\/\/[^\s]+/g, 'mongodb://[redacted]');
}
