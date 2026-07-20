import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0, not just localhost — needed to reach it from phones on LAN
    // dev-only: client runs on :5173, server on :4321. socket.ts connects
    // same-origin (io() with no args) so this proxy keeps that true in dev too —
    // no dev/prod branching needed in client code.
    proxy: {
      '/socket.io': {
        target: 'http://localhost:4321',
        ws: true,
      },
    },
  },
})
