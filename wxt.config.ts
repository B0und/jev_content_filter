import babel from '@rolldown/plugin-babel';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  modules: ['@wxt-dev/module-react'],
  react: {
    vitePluginsBefore: [
      babel({
        include: /\/src\/.*\.[jt]sx$/,
        plugins: [['babel-plugin-react-compiler', { target: '19' }]],
      }),
    ],
  },
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
      'https://api.typesafe.ai/*',
      'https://openrouter.ai/*',
    ],
  },
});
