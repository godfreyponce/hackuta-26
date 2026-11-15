import type { Api, Hub } from './types';
import { createLiveApi } from './api';
import { createMockApi } from './mockApi';
import { createWsHub } from './wsHub';
import { createMockHub } from './mockHub';

export * from './types';

export interface Net {
  api: Api;
  hub: Hub;
  mode: 'live' | 'mock';
  /** Why we're in mock mode (shown in the UI), if we fell back. */
  reason?: string;
  agentConnected: boolean;
}

const params = new URLSearchParams(location.search);
const forceMock = import.meta.env.VITE_MOCK_SERVER === '1' || params.get('mock') === '1';
const forceLive = params.get('mock') === '0';

let friendNameRef = 'Telemachus';
export const setMockFriendName = (n: string) => { friendNameRef = n; };

let netPromise: Promise<Net> | null = null;

/** Resolve live vs mock once. Live server unreachable → mock with a visible reason (robustness). */
export function getNet(): Promise<Net> {
  if (netPromise) return netPromise;
  netPromise = (async (): Promise<Net> => {
    const mock = (reason?: string): Net => ({
      api: createMockApi(),
      hub: createMockHub(() => friendNameRef),
      mode: 'mock',
      reason,
      agentConnected: true,
    });
    if (forceMock) return mock('Mock mode (VITE_MOCK_SERVER=1)');
    const live = createLiveApi();
    try {
      const h = await live.health();
      if (!h.ok) throw new Error('unhealthy');
      return { api: live, hub: createWsHub(), mode: 'live', agentConnected: h.agentConnected };
    } catch {
      if (forceLive) return { api: live, hub: createWsHub(), mode: 'live', agentConnected: false };
      return mock('Server unreachable — playing with the mock hub');
    }
  })();
  return netPromise;
}
