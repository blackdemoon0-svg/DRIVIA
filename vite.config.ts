import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  // Le serveur de développement est consulté à travers le proxy d'aperçu
  // (domaine *.e2b.app). Vite refuse par défaut les hôtes inconnus avec un 403,
  // ce qui empêcherait l'aperçu de s'afficher. Réglage de développement
  // uniquement : le build de production n'est pas concerné.
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
