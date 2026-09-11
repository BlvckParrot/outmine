import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true },
  // For the second build - `vite build --ssr src/ssr.tsx` - everything goes in the
  // bundle, react included. The production image installs only the server's
  // dependencies and react is not one of them, so anything left external would
  // resolve to nothing at runtime.
  ssr: { noExternal: true },
  // No proxy on purpose: the client dials VITE_API_ORIGIN directly in development.
  // See src/api.ts.
});
