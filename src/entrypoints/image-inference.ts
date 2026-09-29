import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { imageClassifier } from '../content/image-model';

export default defineUnlistedScript(() => {
  // Dynamic import executes in the extension's isolated world, not X's page world.
  globalThis.jevImageClassifier = imageClassifier;
});
