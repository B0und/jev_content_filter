import { defineConfig } from 'vite';
import { createBenchmarkStoragePlugin } from './storage-server';

export default defineConfig({
  plugins: [createBenchmarkStoragePlugin()],
});
