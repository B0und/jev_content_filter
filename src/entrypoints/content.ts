// Content entrypoint: WXT wiring only. The runtime lives in src/content/.
import { defineContentScript } from 'wxt/utils/define-content-script';
import { startContentFilter } from '../content/runtime';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    return startContentFilter(ctx);
  },
});
