import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/worker.mjs", import.meta.url);

export function deploymentTarget(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const workerName = (
    env.WRANGLER_CI_OVERRIDE_NAME || env.CLOUDFLARE_WORKER_NAME
  )?.trim();
  if (!accountId || !token || !workerName) {
    throw new Error(
      "Set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_WORKER_NAME in build variables (Workers Builds may supply WRANGLER_CI_OVERRIDE_NAME).",
    );
  }
  return { accountId, token, workerName };
}

export async function uploadWorker(code, target, fetcher = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(target.accountId)}/workers/scripts/${encodeURIComponent(target.workerName)}`;
  const headers = { Authorization: `Bearer ${target.token}` };
  const settingsResponse = await fetcher(`${base}/settings`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const settings = await readResult(settingsResponse);
  if (
    !settings.bindings?.some(
      (binding) =>
        binding.name === "STATUS_KV" && binding.type === "kv_namespace",
    )
  ) {
    throw new Error(
      "Create the Worker and bind STATUS_KV in the Cloudflare Dashboard before deploying.",
    );
  }
  const form = new FormData();
  form.set(
    "metadata",
    new Blob([JSON.stringify({ main_module: "worker.mjs" })], {
      type: "application/json",
    }),
  );
  form.set(
    "worker.mjs",
    new Blob([code], { type: "application/javascript+module" }),
    "worker.mjs",
  );
  // The content endpoint updates code only. Do not use the script upload or
  // settings endpoints: those can overwrite Dashboard-owned configuration.
  const response = await fetcher(`${base}/content`, {
    method: "PUT",
    headers,
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  await readResult(response);
}

async function readResult(response) {
  const payload = await response.json();
  if (!response.ok || payload.success !== true || !payload.result) {
    throw new Error(
      `Cloudflare API request failed (HTTP ${response.status}); check deployment permissions and the target Worker.`,
    );
  }
  return payload.result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run"))
    throw new Error("Only --dry-run is supported.");
  const dryRun = args.includes("--dry-run");
  const target = dryRun ? null : deploymentTarget(process.env);
  await build({
    absWorkingDir: root,
    entryPoints: ["src/index.ts"],
    outfile: fileURLToPath(output),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
  });
  if (dryRun) {
    console.log(
      "Built dist/worker.mjs. No Cloudflare request or configuration change was made.",
    );
    return;
  }
  await uploadWorker(await readFile(output), target);
  console.log(
    `Updated code for ${target.workerName}; Dashboard configuration was not modified.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
