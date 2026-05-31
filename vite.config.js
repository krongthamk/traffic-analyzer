import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes asset paths relative, so the built site works on
// GitHub Pages project sites, Netlify, Vercel, S3, or any subfolder
// without further configuration.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
