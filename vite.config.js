import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

function boolEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function localDashboardHtml() {
  const requireApi = boolEnv(process.env.VITE_REQUIRE_API);
  const demoFallback = boolEnv(process.env.VITE_DEMO_FALLBACK);
  const includeDemoData = !requireApi && (process.env.NODE_ENV !== "production" || demoFallback);
  if (!includeDemoData) return "";
  try {
    return readFileSync(new URL("./oa-dashboard.html", import.meta.url), "utf8");
  } catch {
    return "";
  }
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  define: {
    __LOCAL_DASHBOARD_HTML__: JSON.stringify(localDashboardHtml())
  },
  plugins: [react()],
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
