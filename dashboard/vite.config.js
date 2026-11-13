import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development the Python API (python -m training.api) runs on :8000.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
