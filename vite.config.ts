import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const isTest = process.env.VITEST !== undefined;
const testMigrations = isTest ? await readD1Migrations("migrations") : [];
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

const testConfig = {
  OWNER_EMAIL: "alex.personal@example.com",
  ACCESS_ISSUER: "https://example-team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "a".repeat(64),
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake",
  TOKEN_KEY: "b".repeat(64),
};

export default defineConfig({
  server: { host: true },
  plugins: isTest ? [] : [tailwindcss(), cloudflare()],
  resolve: { alias },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: ["src/pages/client.tsx", "src/styles.css"],
          output: { entryFileNames: "assets/[name].js", assetFileNames: "assets/[name][extname]" },
        },
      },
    },
  },
  test: {
    projects: isTest
      ? [
          {
            plugins: [
              tailwindcss(),
              cloudflareTest({
                wrangler: { configPath: "./wrangler.jsonc" },
                miniflare: {
                  bindings: { ...testConfig, TEST_MIGRATIONS: testMigrations },
                  serviceBindings: {
                    TEST_BROWSER: async (request) => {
                      const { hydrateAccounts } = await import("./test/browser/hydration");
                      return Response.json(
                        await hydrateAccounts(
                          (await request.json()) as Parameters<typeof hydrateAccounts>[0],
                        ),
                      );
                    },
                  },
                },
              }),
            ],
            resolve: { alias },
            test: {
              name: "worker",
              include: ["test/*.test.ts"],
              setupFiles: ["./test/setup.ts"],
              fsModuleCache: false,
            },
          },
          {
            test: { name: "repo", environment: "node", include: ["test/repo/*.test.ts"] },
          },
        ]
      : undefined,
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["worker-configuration.d.ts", "dist/**"],
  },
  fmt: {
    ignorePatterns: ["worker-configuration.d.ts", "dist/**", "test/fixtures/cimd/*.json"],
  },
});
