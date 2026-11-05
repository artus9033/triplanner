import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // PORT and WEB_PORT may live in the repo-root .env. Only these two values are used here.
  const fileEnv = loadEnv(mode, fileURLToPath(new URL("..", import.meta.url)), "");
  const webPort = Number(process.env.WEB_PORT ?? fileEnv.WEB_PORT ?? 5173);
  const apiPort = Number(process.env.PORT ?? fileEnv.PORT ?? 3000);

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      // The optional handover tunnel (design/03, "Taking control") arrives with this Host header.
      allowedHosts: [".trycloudflare.com"],
      proxy: {
        // http-proxy streams the response, so the SSE route passes through unbuffered.
        "/api": { target: `http://127.0.0.1:${apiPort}` },
      },
    },
  };
});
