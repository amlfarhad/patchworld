import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Rapier's compatibility package embeds its WASM as a large JS asset.
    chunkSizeWarningLimit: 5000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]rapier3d-compat/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    watch: {
      // Runtime output of the sync daemon, and docs. Changes to these silently reloaded the page,
      // which killed the playtest in progress whenever the agent published SKILL.md.
      ignored: ['**/.agents/**', '**/artifacts/**', '**/src/generated/*.tmp', '**/*.md'],
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 10,
      },
    },
  },
})
