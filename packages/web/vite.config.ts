import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true },
  // No proxy on purpose: the client dials VITE_API_ORIGIN directly in development.
  // See src/api.ts.
});
