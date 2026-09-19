// Background entrypoint: thin MV3 definition. All listener registration
// happens synchronously inside startBackground() — the substantive runtime
// lives in src/background/runtime.ts for testability at the message seams.
import { defineBackground } from 'wxt/utils/define-background';
import { startBackground } from '../background/runtime';

export default defineBackground(() => {
  startBackground();
});
