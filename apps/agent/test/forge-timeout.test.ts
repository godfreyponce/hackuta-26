// The agent's POST /api/forge against the server's real limits (integration checks a and c).
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

// The server runs vision for up to 8.5 s, then retries once (apps/server/src/ai/vision.ts analyzeWithRetry).
const SERVER_WORST_MS = 2 * 8_500;

let delayMs = 0;
let lastHeaders: IncomingHttpHeaders = {};
const server = createServer((req, res) => {
  lastHeaders = req.headers;
  req.resume();
  req.on('end', () => setTimeout(() => {
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ forgeId: 'f1', objectName: 'frying pan', displayName: 'Pan', weaponClass: 'blunt', quip: 'Forging now.' }));
  }, delayMs));
});

type Forge = { forge(jpeg: Buffer): Promise<{ hit: { forgeId: string } | null }> };
let scanner: Forge;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  process.env.SERVER_HTTP_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
  const { CallerScanner } = await import('../src/scanner.ts');
  scanner = new CallerScanner('s1') as unknown as Forge;
});

after(() => { server.closeAllConnections(); server.close(); });

test('forge calls carry x-session-id, which the server rate limit keys on (apps/server/src/routes/api.ts)', async () => {
  delayMs = 0;
  await scanner.forge(JPEG);
  assert.equal(lastHeaders['x-session-id'], 's1');
});

// If the agent gives up first, the server still forges and spawns a weapon the Quartermaster never announces.
test('a forge reply that takes the server worst case is still a hit', { timeout: SERVER_WORST_MS + 10_000 }, async () => {
  delayMs = SERVER_WORST_MS;
  assert.equal((await scanner.forge(JPEG)).hit?.forgeId, 'f1');
});
