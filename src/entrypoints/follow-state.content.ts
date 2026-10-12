import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  collectFollowStates,
  readFollowViewer,
  type FollowState,
} from '../content/follow-observation';

/** Observe X's existing requests. Page scripts are trusted; response shapes still need validation. */
export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const fetchPage = window.fetch.bind(window);
    const api = /^https:\/\/(?:x\.com|twitter\.com)\/i\/api\/(graphql|1\.1)\//;
    const users = new Map<string, { following: boolean; sequence: number }>();
    let messageSequence = 0;
    let requestSequence = 0;
    let epoch = 0;
    let viewer: string | null = null;

    const send = () =>
      window.postMessage(
        {
          type: 'jev-follow-state',
          epoch,
          viewer,
          sequence: ++messageSequence,
          users: Array.from(users, ([handle, state]) => ({ handle, following: state.following })),
        },
        location.origin,
      );

    const refreshViewer = () => {
      const current = readFollowViewer();

      if (current === viewer) return;
      viewer = current;
      epoch++;
      users.clear();
      send();
    };

    new MutationObserver(refreshViewer).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-testid'],
    });

    const publish = (updates: FollowState[], sequence: number, requestEpoch: number) => {
      refreshViewer();

      if (!viewer || requestEpoch !== epoch) return;
      let changed = false;

      for (const user of updates) {
        if (sequence < (users.get(user.handle)?.sequence ?? -1)) continue;
        users.set(user.handle, { following: user.following, sequence });
        changed = true;
      }

      while (users.size > 5000) {
        const oldest = users.keys().next();

        if (oldest.done) break;
        users.delete(oldest.value);
      }

      if (changed) send();
    };

    window.addEventListener('message', (event) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === 'jev-follow-request'
      ) {
        refreshViewer();
        send();
      }
    });

    window.fetch = async (...args) => {
      refreshViewer();
      const requestEpoch = epoch;
      const sequence = ++requestSequence;
      const response = await fetchPage(...args);

      if (response.ok && api.test(response.url)) {
        try {
          void response
            .clone()
            .json()
            .then((data) => publish(collectFollowStates(data), sequence, requestEpoch))
            .catch(() => {});
        } catch {
          // Observing a consumed response must not fail the page's request.
        }
      }

      return response;
    };

    window.XMLHttpRequest = class extends XMLHttpRequest {
      private requestEpoch = 0;
      private sequence = 0;

      constructor() {
        super();
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300 || !api.test(this.responseURL)) return;

          try {
            if (this.responseType === 'json')
              publish(collectFollowStates(this.response), this.sequence, this.requestEpoch);
            else if (!this.responseType || this.responseType === 'text')
              publish(
                collectFollowStates(JSON.parse(this.responseText)),
                this.sequence,
                this.requestEpoch,
              );
          } catch {
            // Non-JSON responses carry no follow observations.
          }
        });
      }

      override open(
        method: string,
        url: string | URL,
        async = true,
        username: string | null = null,
        password: string | null = null,
      ) {
        refreshViewer();
        this.requestEpoch = epoch;
        this.sequence = ++requestSequence;
        super.open(method, url, async, username, password);
      }
    };
  },
});
