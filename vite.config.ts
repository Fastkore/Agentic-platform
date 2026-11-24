import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const compressedAssets: Plugin = {
  name: 'precompress-static-assets',
  apply: 'build',
  async writeBundle({ dir }, bundle) {
    if (!dir) return;
    for (const name of Object.keys(bundle)) {
      if (!/\.(?:js|css)$/.test(name)) continue;
      const file = join(dir, name);
      const data = await readFile(file);
      if (data.length < 1024) continue;
      await writeFile(file + '.gz', gzipSync(data));
      await writeFile(file + '.br', brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 6 },
      }));
    }
  },
};
export default defineConfig({ plugins: [react(), tailwindcss(), compressedAssets], build: { outDir: 'dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } } });
