import { defineContentScript } from 'wxt/utils/define-content-script';
import { collectFollowStates } from '../content/relationships';

/** Observe X's existing responses without extra requests, cookies or credentials. */
export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const users = new Map<string, { following: boolean; sequence: number }>();
    let requestSequence = 0;
    const publish = (data: unknown, sequence: number) => {
      const updates = collectFollowStates(data).filter(
        (user) => sequence >= (users.get(user.handle)?.sequence ?? -1),
      );
      if (!updates.length) return;
      for (const user of updates) users.set(user.handle, { following: user.following, sequence });
      // Retain only a bounded page-local handshake buffer.
      while (users.size > 5000) users.delete(users.keys().next().value!);
      window.postMessage({ type: 'jev-follow-state', users: updates }, location.origin);
    };
    window.addEventListener('message', (event) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === 'jev-follow-request'
      )
        window.postMessage(
          {
            type: 'jev-follow-state',
            users: [...users].map(([handle, state]) => ({ handle, following: state.following })),
          },
          location.origin,
        );
    });
    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      const sequence = ++requestSequence;
      const response = await nativeFetch.apply(this, args);
      if (response.ok && /\/i\/api\/(graphql|1\.1)\//.test(response.url)) {
        void response
          .clone()
          .json()
          .then((data) => publish(data, sequence))
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
            if (this.responseType === 'json') publish(this.response, sequence);
            else if (!this.responseType || this.responseType === 'text')
              publish(JSON.parse(this.responseText), sequence);
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
