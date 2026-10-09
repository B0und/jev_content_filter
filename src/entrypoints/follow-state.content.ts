import { defineContentScript } from 'wxt/utils/define-content-script';
import { collectFollowStates, type FollowState } from '../content/native-follow-parser';

declare global {
  interface Window {
    __jevFollowBootstrap?: (secret: number[]) => boolean;
  }
}

/** Capture native observers before page scripts; only extension-delivered keys sign updates. */
export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    const encode = new TextEncoder().encode.bind(new TextEncoder());
    const nativeFetch = window.fetch.bind(window);
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its Response receiver.
    const clone = Response.prototype.clone;
    // oxlint-disable-next-line typescript/unbound-method -- captured getter uses the native Response receiver.
    const responseOk = Object.getOwnPropertyDescriptor(Response.prototype, 'ok')!.get!;
    // oxlint-disable-next-line typescript/unbound-method -- captured getter uses the native Response receiver.
    const responseURL = Object.getOwnPropertyDescriptor(Response.prototype, 'url')!.get!;
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its Response receiver.
    const json = Response.prototype.json;
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its Promise receiver.
    const then = Promise.prototype.then;
    const apply = Reflect.apply;
    const Uint8 = Uint8Array;
    const postMessage = window.postMessage.bind(window);
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its original receiver.
    const getAttribute = Element.prototype.getAttribute;
    const querySelector = document.querySelector.bind(document);
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its original receiver.
    const exec = RegExp.prototype.exec;
    const define = Object.defineProperty;
    // oxlint-disable-next-line typescript/unbound-method -- invoked with its original string receiver.
    const lower = String.prototype.toLowerCase;
    const api = /^https:\/\/(?:x\.com|twitter\.com)\/i\/api\/(graphql|1\.1)\//;
    const profilePath = /^\/([a-zA-Z0-9_]{1,15})\/?$/;
    const users = new Map<string, { following: boolean; sequence: number }>();

    const get = users.get.bind(users),
      set = users.set.bind(users),
      clear = users.clear.bind(users),
      remove = users.delete.bind(users),
      forEach = users.forEach.bind(users);

    const ownKeys = users.keys.bind(users);
    const iteratorNext = Object.getPrototypeOf(users.keys()).next;
    let signingKey: Promise<CryptoKey> | null = null;

    let messageSequence = 0,
      requestSequence = 0,
      epoch = 0;

    let viewer: string | null = null;

    /** Read the captured map without mutable page-side iteration helpers. */
    const snapshot = () => {
      const result: Array<{ handle: string; following: boolean }> = [];
      forEach((state, handle) => {
        define(result, result.length, {
          value: { handle, following: state.following },
          enumerable: true,
        });
      });

      return result;
    };

    /** Canonical ASCII serialization avoids page-controlled toJSON hooks. */
    const send = (updates: Array<{ handle: string; following: boolean }>) => {
      if (!signingKey) return;
      let rows = '';

      for (let i = 0; i < updates.length; i++) {
        const u = updates[i]!;
        rows +=
          (i ? ',' : '') +
          '{"handle":"' +
          u.handle +
          '","following":' +
          (u.following ? 'true' : 'false') +
          '}';
      }

      const payload =
        '{"epoch":' +
        epoch +
        ',"viewer":' +
        (viewer ? '"' + viewer + '"' : 'null') +
        ',"sequence":' +
        ++messageSequence +
        ',"users":[' +
        rows +
        ']}';

      apply(then, signingKey, [
        (key: CryptoKey) => {
          apply(then, sign('HMAC', key, encode(payload)), [
            (mac: ArrayBuffer) => {
              const bytes = new Uint8(mac),
                signature: number[] = [];

              for (let i = 0; i < bytes.length; i++)
                define(signature, i, { value: bytes[i]!, enumerable: true });
              postMessage({ type: 'jev-follow-state', payload, signature }, location.origin);
            },
            () => {},
          ]);
        },
        () => {},
      ]);
    };

    /** Invalidate relationship observations when X's active profile changes or disappears. */
    const refreshViewer = () => {
      const profile = querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const href = profile ? apply(getAttribute, profile, ['href']) : null;
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
      const match = typeof href === 'string' ? apply(exec, profilePath, [href]) : null;
      const current = match?.[1] ? apply(lower, match[1], []) : null;

      if (current === viewer) return;
      viewer = current;
      epoch++;
      clear();
      send([]);
    };

    new MutationObserver(refreshViewer).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'data-testid'],
    });

    /** Accept only current-viewer native responses and preserve request-start ordering. */
    const publish = (updates: FollowState[], sequence: number, requestEpoch: number) => {
      refreshViewer();

      if (!viewer || requestEpoch !== epoch) return;
      let changed = false;

      for (let i = 0; i < updates.length; i++) {
        const u = updates[i]!;

        if (sequence < (get(u.handle)?.sequence ?? -1)) continue;
        set(u.handle, { following: u.following, sequence });
        changed = true;
      }

      while (users.size > 5000) {
        const iterator = ownKeys();
        const oldest = apply(iteratorNext, iterator, []);

        if (
          oldest &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
          typeof oldest === 'object' &&
          'value' in oldest &&
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Native response parsing uses captured intrinsics to resist page-side tampering.
          typeof oldest.value === 'string'
        )
          remove(oldest.value);
        else break;
      }

      if (changed) send(snapshot());
    };

    window.addEventListener('message', (event) => {
      if (
        event.source === window &&
        event.origin === location.origin &&
        event.data?.type === 'jev-follow-request'
      ) {
        refreshViewer();
        send(snapshot());
      }
    });
    window.fetch = async function (...args) {
      refreshViewer();

      const requestEpoch = epoch,
        sequence = ++requestSequence;

      const response = await nativeFetch(...args);

      if (apply(responseOk, response, []) && apply(exec, api, [apply(responseURL, response, [])])) {
        const body = apply(json, apply(clone, response, []), []);
        void apply(then, body, [
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native response parsing uses captured intrinsics to resist page-side tampering.
          (data: unknown) => publish(collectFollowStates(data), sequence, requestEpoch),
          () => {},
        ]);
      }

      return response;
    };

    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with the original XHR receiver.
    const nativeOpen = XMLHttpRequest.prototype.open;
    // oxlint-disable-next-line typescript/unbound-method -- invoked through captured Reflect.apply with its original receiver.
    const addListener = XMLHttpRequest.prototype.addEventListener;
    const parse = JSON.parse;

    /* oxlint-disable typescript/unbound-method -- native getters invoked through captured Reflect.apply with the original XHR receiver. */
    const responseUrl = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype,
      'responseURL',
    )!.get!;

    const responseStatus = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype,
      'status',
    )!.get!;

    const responseType = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype,
      'responseType',
    )!.get!;

    const responseText = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype,
      'responseText',
    )!.get!;

    /* oxlint-enable typescript/unbound-method */
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async = true,
      username: string | null = null,
      password: string | null = null,
    ) {
      refreshViewer();

      const requestEpoch = epoch,
        sequence = ++requestSequence;

      apply(addListener, this, [
        'load',
        () => {
          const status = apply(responseStatus, this, []);

          if (status < 200 || status >= 300 || !apply(exec, api, [apply(responseUrl, this, [])]))
            return;

          try {
            const type = apply(responseType, this, []);

            // JSON-mode XHR exposes a mutable object to earlier page listeners; ignore it.
            if (!type || type === 'text')
              publish(
                collectFollowStates(parse(apply(responseText, this, []))),
                sequence,
                requestEpoch,
              );
          } catch {
            /* Ignore non-JSON native responses. */
          }
        },
        { once: true },
      ]);
      apply(nativeOpen, this, [method, url, async, username, password]);
    };

    /** The background supplies this key through scripting, never through page messages. */
    const bootstrap = (secret: number[]) => {
      if (signingKey) return false;
      const bytes = new Uint8(32);

      for (let i = 0; i < 32; i++) bytes[i] = secret[i]!;
      signingKey = importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      refreshViewer();
      send(snapshot());

      return true;
    };

    define(window, '__jevFollowBootstrap', {
      value: bootstrap,
      writable: false,
      configurable: false,
    });
  },
});
