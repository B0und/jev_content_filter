import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Jev Feed Filter',
    icons: {
      16: '/icons/normal-16.png',
      32: '/icons/normal-32.png',
      48: '/icons/normal-48.png',
      128: '/icons/normal-128.png',
    },
    permissions: ['storage'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'https://ai-gateway.vercel.sh/*',
    ],
  },
});
