import { expect, it } from "vite-plus/test";
import { childEnv, deploy, type Io, type Run } from "../../scripts/deploy.ts";

// The deploy command against a fake wrangler, build, terminal, and network. Each test reads the
// ordered record of what the command did.

const HOST = "mcp.example.com";
const ALL = [
  "OWNER_EMAIL",
  "ACCESS_ISSUER",
  "ACCESS_AUDIENCE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "TOKEN_KEY",
];
const VALID: Record<string, string> = {
  OWNER_EMAIL: "alex.personal@example.com",
  ACCESS_ISSUER: "https://example-team.cloudflareaccess.com",
  ACCESS_AUDIENCE: "a".repeat(64),
  GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "fake",
};
const GENERATED_KEY = "c".repeat(64);
const NOT_FOUND = `✘ [ERROR] Worker "google-accounts-mcp" not found.\n\n  If this is a new Worker, run \`wrangler deploy\` first to create it.`;
// What the server answers on each path the deploy checks (seen on a local `vp dev`).
const SERVER: Record<string, number> = {
  "/mcp": 401,
  "/.well-known/oauth-authorization-server": 200,
  "/oauth/token": 405,
  "/uploads/": 404,
};
const ok = (stdout = ""): Run => ({ code: 0, stdout, stderr: "" });

interface Fake {
  workerSecrets?: string[] | null;
  env?: Record<string, string>;
  interactive?: boolean;
  answers?: string[];
  fail?: string;
  pendingAfterApply?: boolean;
  secretList?: string;
  statuses?: Record<string, number>;
}

function fake(options: Fake = {}) {
  const steps: string[] = [];
  const modes = new Map<string, string>();
  const logs: string[] = [];
  const secretsFiles: Record<string, string>[] = [];
  const asked: { question: string; hidden: boolean }[] = [];
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    env: options.env ?? {},
    interactive: options.interactive ?? true,
    log: (line) => logs.push(line),
    ask: async (question, hidden) => {
      asked.push({ question, hidden });
      return answers.shift() ?? "";
    },
    exec: async (bin, args, mode = "terminal") => {
      const step = [bin, ...args].join(" ");
      steps.push(step);
      modes.set(step, mode);
      if (options.fail !== undefined && step.startsWith(options.fail))
        return { code: 1, stdout: "", stderr: "failed" };
      if (step === "wrangler secret list --format json" && options.secretList !== undefined)
        return ok(options.secretList);
      if (step === "wrangler secret list --format json") {
        const names = options.workerSecrets === undefined ? ALL : options.workerSecrets;
        return names === null
          ? { code: 1, stdout: "", stderr: NOT_FOUND }
          : ok(JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))));
      }
      if (step === "wrangler d1 migrations list DB --remote")
        return ok(options.pendingAfterApply ? "0011_next.sql" : "✅ No migrations to apply!");
      return ok();
    },
    withSecretsFile: async (values, use) => {
      secretsFiles.push(values);
      steps.push("write secrets");
      try {
        return await use("/tmp/secrets.json");
      } finally {
        steps.push("remove secrets");
      }
    },
    status: async (url) => {
      const path = new URL(url).pathname;
      return options.statuses?.[path] ?? SERVER[path] ?? 0;
    },
    sleep: async () => {},
    randomKey: () => GENERATED_KEY,
  };
  return { io, steps, modes, logs, secretsFiles, asked };
}

const MIGRATE = [
  "wrangler d1 migrations apply DB --remote",
  "wrangler d1 migrations list DB --remote",
];

it("deploys a new Worker with every setting, then migrates the database it created", async () => {
  const run = fake({
    workerSecrets: null,
    env: { OWNER_EMAIL: VALID.OWNER_EMAIL! },
    answers: [
      VALID.ACCESS_ISSUER!,
      VALID.ACCESS_AUDIENCE!,
      VALID.GOOGLE_CLIENT_ID!,
      VALID.GOOGLE_CLIENT_SECRET!,
    ],
  });
  expect(await deploy([HOST], run.io)).toBe(true);
  expect(run.steps).toEqual([
    "wrangler secret list --format json",
    "vp build",
    "write secrets",
    `wrangler deploy --domain ${HOST} --secrets-file /tmp/secrets.json`,
    "remove secrets",
    ...MIGRATE,
  ]);
  expect(run.secretsFiles).toEqual([{ ...VALID, TOKEN_KEY: GENERATED_KEY }]);
  // The value from the environment is not asked for; only the client secret is typed hidden.
  expect(run.asked).toEqual([
    { question: "ACCESS_ISSUER: ", hidden: false },
    { question: "ACCESS_AUDIENCE: ", hidden: false },
    { question: "GOOGLE_CLIENT_ID: ", hidden: false },
    { question: "GOOGLE_CLIENT_SECRET: ", hidden: true },
  ]);
  // Unattended, wrangler creates the database under the name the migrations look for, and
  // leaves wrangler.jsonc as it is.
  expect(run.modes.get(`wrangler deploy --domain ${HOST} --secrets-file /tmp/secrets.json`)).toBe(
    "unattended",
  );
  expect(run.logs.join("\n")).toContain(`redirect URI: https://${HOST}/google/callback`);
  expect(run.logs.at(-1)).toContain(`https://${HOST}/accounts`);
});

it("migrates an existing Worker before it deploys, and sends no settings", async () => {
  const run = fake();
  expect(await deploy([HOST], run.io)).toBe(true);
  expect(run.steps).toEqual([
    "wrangler secret list --format json",
    "vp build",
    ...MIGRATE,
    `wrangler deploy --domain ${HOST}`,
  ]);
  expect(run.asked).toEqual([]);
});

it("sends only the settings an existing Worker lacks", async () => {
  const run = fake({
    workerSecrets: ALL.filter((name) => name !== "GOOGLE_CLIENT_ID"),
    env: VALID,
  });
  expect(await deploy([HOST], run.io)).toBe(true);
  expect(run.secretsFiles).toEqual([{ GOOGLE_CLIENT_ID: VALID.GOOGLE_CLIENT_ID }]);
});

it("asks again for a value the server would refuse, and changes nothing without an answer", async () => {
  const retried = fake({
    workerSecrets: ALL.filter((name) => name !== "ACCESS_AUDIENCE"),
    answers: ["not-hex", VALID.ACCESS_AUDIENCE!],
  });
  expect(await deploy([HOST], retried.io)).toBe(true);
  expect(retried.asked).toHaveLength(2);
  expect(retried.logs).toContain(
    "That is not a valid ACCESS_AUDIENCE. The Application Audience (AUD) tag of the Access application for the whole hostname.",
  );

  const abandoned = fake({ workerSecrets: null, answers: [] });
  expect(await deploy([HOST], abandoned.io)).toBe(false);
  expect(abandoned.steps).toEqual(["wrangler secret list --format json"]);
});

it("refuses an invalid value from the environment, or a missing one without a terminal, before any change", async () => {
  const invalid = fake({ workerSecrets: null, env: { ...VALID, TOKEN_KEY: "short" } });
  expect(await deploy([HOST], invalid.io)).toBe(false);
  expect(invalid.logs.join("\n")).toContain("TOKEN_KEY in the environment is not valid.");
  expect(invalid.steps).toEqual(["wrangler secret list --format json"]);

  const unattended = fake({
    workerSecrets: null,
    interactive: false,
    env: { OWNER_EMAIL: VALID.OWNER_EMAIL! },
  });
  expect(await deploy([HOST], unattended.io)).toBe(false);
  expect(unattended.logs).toContain(
    "Missing settings: ACCESS_ISSUER, ACCESS_AUDIENCE, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.",
  );
  expect(unattended.steps).toEqual(["wrangler secret list --format json"]);
});

it("uses a TOKEN_KEY from the environment instead of generating one", async () => {
  const key = "d".repeat(64);
  const run = fake({ workerSecrets: null, env: { ...VALID, TOKEN_KEY: key } });
  expect(await deploy([HOST], run.io)).toBe(true);
  expect(run.secretsFiles[0]?.TOKEN_KEY).toBe(key);
});

it("deploys nothing when the build or the migrations of an existing Worker fail", async () => {
  for (const fail of ["vp build", "wrangler d1 migrations apply"]) {
    const run = fake({ fail });
    expect(await deploy([HOST], run.io)).toBe(false);
    expect(run.steps.some((step) => step.startsWith("wrangler deploy"))).toBe(false);
  }
  // Declining wrangler's question exits with 0 but leaves migrations pending.
  const declined = fake({ pendingAfterApply: true });
  expect(await deploy([HOST], declined.io)).toBe(false);
  expect(declined.logs).toContain("Some migrations were not applied.");
  expect(declined.steps.some((step) => step.startsWith("wrangler deploy"))).toBe(false);
});

it("removes the settings file when the deploy fails", async () => {
  const run = fake({ workerSecrets: null, env: VALID, fail: "wrangler deploy" });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.steps.slice(-2)).toEqual([
    `wrangler deploy --domain ${HOST} --secrets-file /tmp/secrets.json`,
    "remove secrets",
  ]);
});

it("stops when wrangler cannot read the Worker for another reason", async () => {
  const run = fake({ fail: "wrangler secret list" });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.steps).toEqual(["wrangler secret list --format json"]);
});

it("refuses a missing or malformed hostname before it calls wrangler", async () => {
  for (const args of [[], ["https://mcp.example.com"], [HOST, "extra"], ["Mcp.Example.com"]]) {
    const run = fake();
    expect(await deploy(args, run.io)).toBe(false);
    expect(run.steps).toEqual([]);
  }
});

it("names the missing Bypass application when Access answers /mcp", async () => {
  const run = fake({ statuses: { "/mcp": 302 } });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.logs).toContain("Cloudflare Access covers /mcp: add it to the Bypass application.");
});

it("names the missing Bypass path for uploads too", async () => {
  const run = fake({ statuses: { "/uploads/": 302 } });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.logs).toContain(
    "Cloudflare Access covers /uploads/: add it to the Bypass application.",
  );
});

it("tells the deployer to run again when a new Worker's migrations fail", async () => {
  const run = fake({ workerSecrets: null, env: VALID, fail: "wrangler d1 migrations apply" });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.logs.at(-1)).toContain("Run this command again.");
});

it("stops before the build when the list of secrets is not what wrangler documents", async () => {
  const run = fake({ secretList: '{"name":"OWNER_EMAIL"}' });
  expect(await deploy([HOST], run.io)).toBe(false);
  expect(run.steps).toEqual(["wrangler secret list --format json"]);
});

it("keeps the server's settings out of the build's and wrangler's environment", () => {
  const env = { ...VALID, TOKEN_KEY: GENERATED_KEY, PATH: "/bin", CLOUDFLARE_ACCOUNT_ID: "x" };
  const kept = { PATH: "/bin", CLOUDFLARE_ACCOUNT_ID: "x" };
  const wrangler = childEnv(env, "wrangler");
  expect(Object.keys(wrangler).filter((name) => ALL.includes(name))).toEqual([]);
  expect(wrangler).toMatchObject(kept);
  // Empty, so the build neither copies them nor warns that they are missing.
  const build = childEnv(env, "vp");
  expect(ALL.map((name) => build[name])).toEqual(ALL.map(() => ""));
  expect(build).toMatchObject(kept);
});
