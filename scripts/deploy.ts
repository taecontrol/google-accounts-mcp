import { spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CONFIG_CHECKS, CONFIG_NAMES, type ConfigName } from "../src/config.ts";

// Builds and deploys this checkout to the deployer's Cloudflare account, on their own hostname.
// A new Worker is deployed first and migrated second, because wrangler creates the D1 database
// on the first deploy. An existing Worker is migrated first: CODING_STANDARDS.md requires each
// migration to work with the Worker that is already running.

const WHERE: Record<ConfigName, string> = {
  OWNER_EMAIL: "The email address you sign in to Cloudflare Access with.",
  ACCESS_ISSUER:
    "Your Access team domain, exactly https://<team>.cloudflareaccess.com (Zero Trust, Settings).",
  ACCESS_AUDIENCE:
    "The Application Audience (AUD) tag of the Access application for the whole hostname.",
  GOOGLE_CLIENT_ID: "Your Google OAuth client's ID (Google Cloud, APIs & Services, Credentials).",
  GOOGLE_CLIENT_SECRET: "That client's secret.",
  TOKEN_KEY: "64 hexadecimal characters.",
};
const HIDDEN = new Set<ConfigName>(["GOOGLE_CLIENT_SECRET", "TOKEN_KEY"]);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CHECK_ATTEMPTS = 24;
const CHECK_INTERVAL_MS = 5_000;

export interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
/**
 * How a binary runs: on the terminal, with its output collected, or showing its output while it
 * cannot ask questions. The deploy runs unattended: when wrangler can ask, its first deploy offers
 * to name the database or reuse another one, which the migrations would then not find by its
 * default name, and it writes the new resource IDs into the committed wrangler.jsonc.
 */
export type Mode = "terminal" | "capture" | "unattended";
export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether a person can answer questions on the terminal. */
  readonly interactive: boolean;
  log(line: string): void;
  ask(question: string, hidden: boolean): Promise<string>;
  /** Runs a binary of this checkout, with the environment that `childEnv` returns. */
  exec(bin: "vp" | "wrangler", args: string[], mode?: Mode): Promise<Run>;
  /** Writes the values to a file only this user can read, and removes it after `use` ends. */
  withSecretsFile<T>(values: Record<string, string>, use: (path: string) => Promise<T>): Promise<T>;
  /** The status of a GET, without following redirects; 0 when the request fails. */
  status(url: string): Promise<number>;
  sleep(ms: number): Promise<void>;
  randomKey(): string;
}

/** Deploys to the hostname in `args`; returns whether the server answered as expected. */
export async function deploy(args: readonly string[], io: Io): Promise<boolean> {
  const [host, ...rest] = args;
  if (host === undefined || rest.length > 0 || !HOSTNAME.test(host)) {
    io.log("Usage: pnpm run deploy <hostname>, for example pnpm run deploy mcp.example.com");
    return false;
  }

  const listed = await io.exec("wrangler", ["secret", "list", "--format", "json"], "capture");
  const workerExists = listed.code === 0;
  if (!workerExists && !/not found\.[\s\S]*If this is a new Worker/.test(listed.stderr)) {
    io.log(listed.stderr.trim() || listed.stdout.trim());
    io.log("Wrangler could not read the Worker. Nothing changed.");
    return false;
  }
  const present = workerExists ? secretNames(listed.stdout) : [];
  if (present === null) {
    io.log("Wrangler returned an unexpected list of secrets. Nothing changed.");
    return false;
  }

  if (!workerExists) {
    io.log(`This is a new deploy at https://${host}. Before you go on, set up what the README's`);
    io.log(`Deploy section lists, with these values for ${host}:`);
    io.log(`- Google OAuth client redirect URI: https://${host}/google/callback`);
    io.log(`- Access application with an Allow policy for your email: ${host}`);
    io.log(`- Access application with a Bypass policy for everyone: ${host}/mcp,`);
    io.log(`  ${host}/oauth/*, ${host}/.well-known/*, and ${host}/uploads/*`);
  }
  const secrets = await collectSecrets(
    CONFIG_NAMES.filter((name) => !present.includes(name)),
    io,
  );
  if (secrets === null) return false;

  if ((await io.exec("vp", ["build"])).code !== 0) {
    io.log("The build failed. Nothing deployed.");
    return false;
  }
  if (workerExists && !(await migrate(io))) {
    io.log("Nothing deployed: the running Worker is unchanged.");
    return false;
  }
  const deployArgs = ["deploy", "--domain", host];
  const deployed =
    Object.keys(secrets).length === 0
      ? await io.exec("wrangler", deployArgs, "unattended")
      : await io.withSecretsFile(secrets, (path) =>
          io.exec("wrangler", [...deployArgs, "--secrets-file", path], "unattended"),
        );
  if (deployed.code !== 0) {
    io.log("The deploy failed.");
    return false;
  }
  if (!workerExists && !(await migrate(io))) {
    io.log("The server answers 503 until the migrations are applied. Run this command again.");
    return false;
  }
  return checkServer(host, io);
}

function secretNames(stdout: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    const names = parsed.map((entry: unknown) =>
      entry && typeof entry === "object" && "name" in entry ? entry.name : undefined,
    );
    return names.every((name) => typeof name === "string") ? (names as string[]) : null;
  } catch {
    return null;
  }
}

/** Gathers each missing setting from the environment, a generated key, or the deployer. */
async function collectSecrets(
  missing: readonly ConfigName[],
  io: Io,
): Promise<Record<string, string> | null> {
  const values: Record<string, string> = {};
  const unanswered: ConfigName[] = [];
  for (const name of missing) {
    const fromEnv = io.env[name];
    if (fromEnv !== undefined && fromEnv !== "") {
      if (!CONFIG_CHECKS[name](fromEnv)) {
        io.log(`${name} in the environment is not valid. ${WHERE[name]} Nothing changed.`);
        return null;
      }
      values[name] = fromEnv;
    } else if (name === "TOKEN_KEY") values[name] = io.randomKey();
    else if (!io.interactive) unanswered.push(name);
    else {
      io.log(`${name}: ${WHERE[name]}`);
      let answer = (await io.ask(`${name}: `, HIDDEN.has(name))).trim();
      while (!CONFIG_CHECKS[name](answer)) {
        if (answer === "") {
          io.log("No answer. Nothing changed.");
          return null;
        }
        io.log(`That is not a valid ${name}. ${WHERE[name]}`);
        answer = (await io.ask(`${name}: `, HIDDEN.has(name))).trim();
      }
      values[name] = answer;
    }
  }
  if (unanswered.length > 0) {
    io.log(`Missing settings: ${unanswered.join(", ")}.`);
    io.log("Set them in the environment, or run this command in a terminal. Nothing changed.");
    return null;
  }
  return values;
}

/**
 * The environment of every binary the command runs: without the server's settings, which the
 * Vite build would otherwise copy into a `.dev.vars` file under `dist/`.
 */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = { ...env, WRANGLER_SEND_METRICS: "false" };
  for (const name of CONFIG_NAMES) delete child[name];
  return child;
}

/** Applies the pending migrations, then confirms that none is left. */
async function migrate(io: Io): Promise<boolean> {
  const migrations = ["d1", "migrations", "DB", "--remote"];
  if ((await io.exec("wrangler", migrations.toSpliced(2, 0, "apply"))).code !== 0) {
    io.log("The migrations failed.");
    return false;
  }
  // Declining wrangler's question also exits with 0, so ask D1 what is still pending.
  const left = await io.exec("wrangler", migrations.toSpliced(2, 0, "list"), "capture");
  if (left.code !== 0 || !left.stdout.includes("No migrations to apply")) {
    io.log("Some migrations were not applied.");
    return false;
  }
  return true;
}

/** Waits for the hostname to answer like this server, so a missing setup step shows here. */
async function checkServer(host: string, io: Io): Promise<boolean> {
  // Each path the Bypass application covers, with what the server answers there.
  const exactly = (expected: number) => ({
    label: String(expected),
    ok: (s: number) => s === expected,
  });
  const refused = { label: "4xx", ok: (s: number) => s >= 400 && s < 500 };
  const checks = [
    { path: "/mcp", ...exactly(401) },
    { path: "/.well-known/oauth-authorization-server", ...exactly(200) },
    { path: "/oauth/token", ...refused },
    { path: "/uploads/", ...refused },
  ];
  for (const { path, label, ok } of checks) {
    let status = 0;
    for (let attempt = 1; attempt <= CHECK_ATTEMPTS; attempt++) {
      status = await io.status(`https://${host}${path}`);
      if (ok(status)) break;
      if (attempt === 1) io.log(`Waiting for https://${host}${path} to answer ${label}...`);
      if (attempt < CHECK_ATTEMPTS) await io.sleep(CHECK_INTERVAL_MS);
    }
    if (!ok(status)) {
      io.log(`https://${host}${path} answered ${status || "nothing"}, not ${label}.`);
      if (status >= 300 && status < 400)
        io.log(`Cloudflare Access covers ${path}: add it to the Bypass application.`);
      else if (status === 503)
        io.log("The server refuses requests while a setting is invalid or a migration is missing.");
      return false;
    }
  }
  io.log(
    `Deployed. Sign in at https://${host}/accounts, and connect agents to https://${host}/mcp.`,
  );
  return true;
}

const bin = (name: string) =>
  fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));

function askQuestion(question: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const answer = readline.question(question);
  muted = hidden;
  return Promise.race([
    answer,
    new Promise<string>((resolve) => readline.once("close", () => resolve(""))),
  ]).finally(() => {
    readline.close();
    if (hidden) process.stdout.write("\n");
  });
}

const nodeIo: Io = {
  env: process.env,
  interactive: process.stdin.isTTY === true,
  log: (line) => console.log(line),
  ask: askQuestion,
  exec: (name, args, mode = "terminal") =>
    new Promise((resolve, reject) => {
      const stdio: StdioOptions =
        mode === "terminal"
          ? "inherit"
          : mode === "capture"
            ? ["ignore", "pipe", "pipe"]
            : ["ignore", "inherit", "inherit"];
      // worker-configuration.d.ts types the settings into ProcessEnv for the Worker; the
      // children of this command must not get them.
      const env = childEnv(process.env) as NodeJS.ProcessEnv;
      const options: SpawnOptions = { stdio, env };
      const child = spawn(bin(name), args, options);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }),
  async withSecretsFile(values, use) {
    const dir = await mkdtemp(join(tmpdir(), "google-accounts-mcp-"));
    // Ctrl-C reaches the child, which stops; keep this process alive to remove the file after it.
    const stay = () => {};
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, stay);
    try {
      // JSON, not dotenv: wrangler expands $VAR in a dotenv file.
      const path = join(dir, "secrets.json");
      await writeFile(path, JSON.stringify(values), { mode: 0o600 });
      return await use(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
      for (const signal of signals) process.off(signal, stay);
    }
  },
  status: (url) =>
    fetch(url, { redirect: "manual" }).then(
      (response) => response.status,
      () => 0,
    ),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomKey: () => randomBytes(32).toString("hex"),
};

if (import.meta.main) {
  try {
    if (!(await deploy(process.argv.slice(2), nodeIo))) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
