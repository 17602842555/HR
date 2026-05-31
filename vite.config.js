import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function localDashboardHtml() {
  const requireApi = boolEnv(process.env.VITE_REQUIRE_API);
  const includeDemoData = !requireApi && process.env.NODE_ENV !== "production";
  if (!includeDemoData) return "";
  try {
    return readFileSync(new URL("./oa-dashboard.html", import.meta.url), "utf8");
  } catch {
    return "";
  }
}

function localOaSystemModule() {
  const requireApi = boolEnv(process.env.VITE_REQUIRE_API);
  const commercialBuild = requireApi || process.env.NODE_ENV === "production";
  const path = commercialBuild ? "./src/hooks/emptyOaSystem.js" : "./src/hooks/useOaSystem.js";
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __LOCAL_DASHBOARD_HTML__: JSON.stringify(localDashboardHtml())
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@local-oa-system": localOaSystemModule()
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
          if (id.includes("lucide-react")) return "icons";
          return "vendor";
        }
      }
    }
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  }
});
