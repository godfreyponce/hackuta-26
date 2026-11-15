import { env } from './env';
import { buildApp } from './app';
import { closeMongo, connectMongo } from './db/mongo';
import { hub } from './hub';
import { setChangeStreamActive } from './forge';
import { vision } from './ai/vision';
import { log } from './log';
import { errMsg } from './util';

async function main(): Promise<void> {
  const store = await connectMongo();
  hub.start();

  // Live Armory: Atlas change stream on weapons → armory.new to every web socket.
  if (store) {
    try {
      const stream = store.weapons.watch([{ $match: { operationType: 'insert' } }], { fullDocument: 'updateLookup' });
      stream.on('change', (ch) => {
        if (ch.operationType !== 'insert') return;
        const w = ch.fullDocument;
        const id = w._id.toHexString();
        hub.broadcastWeb({
          type: 'armory.new', weaponId: id, displayName: w.displayName,
          ...(w.thumbFileId ? { thumbUrl: `/api/weapons/${id}/thumb.jpg` } : {}),
        });
      });
      stream.on('error', (e) => { log.warn({ err: errMsg(e) }, 'change stream error — falling back to direct broadcast'); setChangeStreamActive(false); });
      setChangeStreamActive(true);
      log.info('weapons change stream active');
    } catch (e) {
      log.warn({ err: errMsg(e) }, 'change stream unavailable');
    }
  }

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  log.info({ port: env.PORT, vision: vision.name, model3d: env.MODEL3D_PROVIDER, mongo: !!store }, 'ithaca server up');
  if (!env.AGENT_SHARED_SECRET) log.warn('AGENT_SHARED_SECRET not set — the agent cannot connect');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    hub.stop();
    await app.close().catch(() => undefined);
    await closeMongo();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => { log.fatal({ err: errMsg(e) }, 'server failed to start'); process.exit(1); });
