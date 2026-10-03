import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The mini app's server (../server, port 8090) runs separately. Proxying it
// keeps every request same-origin, exactly as behind nginx in production.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://127.0.0.1:8090';
  const proxy = { '/api': { target, changeOrigin: true } };
  return {
    plugins: [react()],
    server: {
      port: 5174,
      // Telegram only opens HTTPS URLs, so development goes through a tunnel
      // (see README); let its hostname in.
      allowedHosts: true,
      proxy,
    },
    preview: { port: 4174, proxy },
  };
});
