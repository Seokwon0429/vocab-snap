import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset URLs work for both user/organization pages and repository pages.
  base: './',
  plugins: [react()],
  build: {
    sourcemap: true,
  },
})
