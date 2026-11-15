// Deletes every stored friend phone number. Run after the event. Usage: pnpm --filter @ithaca/server purge:friends
import { connectMongo, closeMongo } from '../src/db/mongo';

const s = await connectMongo();
if (!s) { console.error('mongo not available'); process.exit(1); }
const r = await s.friends.deleteMany({});
await s.sessions.updateMany({}, { $unset: { friendId: '' } });
console.log(`deleted ${r.deletedCount} friends`);
await closeMongo();
