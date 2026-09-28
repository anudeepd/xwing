import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * X-wing is server rendered: the Python app owns the HTML, so this build only
 * produces the fingerprinted entries the Jinja templates link. There is no
 * index.html and no dev-time HTML shell — `npm run dev` rebuilds on change and
 * the Python server serves the result.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8989', changeOrigin: true },
      '/_upload': { target: 'http://127.0.0.1:8989', changeOrigin: true },
      '/_auth': { target: 'http://127.0.0.1:8989', changeOrigin: true },
    },
  },
  build: {
    outDir: '../static/assets',
    emptyOutDir: true,
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: false,
    // The post-build step reads this to write xwing's own manifest, which is
    // what `asset()` in app.py resolves.
    manifest: true,
    // Every page links its own entry; nothing is preloaded by hand.
    modulePreload: false,
    // The four bundled font faces are referenced by absolute URL and copied by
    // the post-build step, so there is nothing for Vite to inline here.
    assetsInlineLimit: 4096,
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, 'src/app.tsx'),
        editor: path.resolve(__dirname, 'src/editor.tsx'),
        admin: path.resolve(__dirname, 'src/admin.ts'),
        style: path.resolve(__dirname, 'src/style.css'),
        'admin-styles': path.resolve(__dirname, 'src/admin.css'),
      },
      output: {
        entryFileNames: '[name]-[hash].js',
        chunkFileNames: 'chunk-[name]-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
})
