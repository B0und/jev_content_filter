import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// @webext-core/fake-browser implements badge/title state in memory but has
// no setIcon. The runtime already tolerates icon failures; stub only what is
// missing so badge assertions use the real fake state.
Object.assign(fakeBrowser.action, { setIcon: vi.fn(async () => undefined) });
