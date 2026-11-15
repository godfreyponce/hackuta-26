// One JSON line per event. Never pass tokens or keys in fields; phone numbers go through maskPhone.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export function warn(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'warn', event, ...fields }));
}

/** "+15551234567" -> "+1•••••4567" */
export function maskPhone(e164: string): string {
  return e164.length < 6 ? '•••' : `${e164.slice(0, 2)}•••••${e164.slice(-4)}`;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
