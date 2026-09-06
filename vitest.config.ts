import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.local.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.spec.ts"],
  },
});
