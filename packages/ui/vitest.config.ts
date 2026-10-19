import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: { __PODGAZE_VERSION__: JSON.stringify("test") },
  test: {
    environment: "jsdom",
    // The App suite renders the whole UI per test; under a full parallel run the terminal tests need more than 5s.
    testTimeout: 15000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
