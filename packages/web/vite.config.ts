/**
 * The web UI's build (docs/bot-os.md D43): Vite bundles the React app of `src/ui/` into `dist/`,
 * which the UI's server (`src/server/web-server.ts`) serves. The repository's only build step:
 * `npm run build`, in CI and in MegaBotTron1999's image.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  // Relative asset paths, so that the app works under any path the proxy gives it.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Monaco's chunks (the script editor, docs/bot-os.md D78) are large, and loaded only when a
    // script is opened; the app's own stays small.
    chunkSizeWarningLimit: 8000,
    rolldownOptions: {
      // React Flow marks its modules "use client", for React's server components, which this app
      // does not use: the directive means nothing in a client bundle.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
});
