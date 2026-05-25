import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is /vgmedit/ for production so the GitHub Pages bundle resolves
// asset URLs under the project path; local dev keeps /.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  server: { port: 5173 },
  base: command === 'build' ? '/vgmedit/' : '/',
}));
