import { defineContentScript } from 'wxt/utils/define-content-script';
import { collectFollowStates } from '../content/relationships';

/** Observe X's existing responses without extra requests, cookies or credentials. */
export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  /** Observe native responses and keep relationships within the active viewer epoch. */
  main() {
    const users = new Map<string, { following: boolean; sequence: number }>();
    let requestSequence = 0;
    let viewer: string | null = null;
    let epoch = 0;
    /** Fail closed when X changes or removes its own active-profile navigation. */
    const refreshViewer = () => {
      const href = document
        .querySelector('[data-testid="AppTabBar_Profile_Link"]')
        ?.getAttribute('href');
      const match = href?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/);
      const current = match?.[1]?.toLowerCase() ?? null;
      if (current === viewer) return;
      viewer = current;
      epoch++;
      users.clear();
      window.postMessage({ type: 'jev-follow-state', epoch, users: [] }, location.origin);
    };
    const viewerObserver = new MutationObserver(refreshViewer);
    viewerObserver.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-testid'],
    });
    /** Ignore earlier-viewer and older per-author responses before publishing. */
    const publish = (data: unknown, sequence: number, requestEpoch: number) => {
      refreshViewer();
      if (!viewer || requestEpoch !== epoch) return;
      const updates = collectFollowStates(data).filter(
        (user) => sequence >= (users.get(user.handle)?.sequence ?? -1),
      );
      if (!updates.length) return;
      for (const user of updates) users.set(user.handle, { following: user.following, sequence });
      // Retain only a bounded page-local handshake buffer.
      while (users.size > 5000) users.delete(users.keys().next().value!);
      window.postMessage({ type: 'jev-follow-state', epoch, users: updates }, location.origin);
    };
    window.addEventListener('message', (event) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === 'jev-follow-request'
      ) {
        refreshViewer();
        window.postMessage(
          {
            type: 'jev-follow-state',
            epoch,
            users: [...users].map(([handle, state]) => ({ handle, following: state.following })),
          },
          location.origin,
        );
      }
    });
    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      refreshViewer();
      const requestEpoch = epoch;
      const sequence = ++requestSequence;
      const response = await nativeFetch.apply(this, args);
      if (response.ok && /\/i\/api\/(graphql|1\.1)\//.test(response.url)) {
        void response
          .clone()
          .json()
          .then((data) => publish(data, sequence, requestEpoch))
          .catch(() => {});
      }
      return response;
    };
    // oxlint-disable-next-line typescript/unbound-method -- invoked with each original XHR receiver.
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username: string | null = null,
      password: string | null = null,
    ) {
      refreshViewer();
      const requestEpoch = epoch;
      const sequence = ++requestSequence;
      this.addEventListener(
        'load',
        () => {
          if (
            this.status < 200 ||
            this.status >= 300 ||
            !/\/i\/api\/(graphql|1\.1)\//.test(this.responseURL)
          )
            return;
          try {
            if (this.responseType === 'json') publish(this.response, sequence, requestEpoch);
            else if (!this.responseType || this.responseType === 'text')
              publish(JSON.parse(this.responseText), sequence, requestEpoch);
          } catch {
            /* Non-JSON responses do not provide a relationship. */
          }
        },
        { once: true },
      );
      nativeOpen.call(this, method, url, async, username, password);
    };
  },
});
