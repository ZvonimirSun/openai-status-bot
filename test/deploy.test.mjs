import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentTarget, uploadWorker } from "../scripts/deploy.mjs";

test("deployment requires build credentials and has no hardcoded target", () => {
  assert.throws(() => deploymentTarget({}), /build variables/);
  assert.deepEqual(
    deploymentTarget({
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_WORKER_NAME: "local",
      WRANGLER_CI_OVERRIDE_NAME: "ci-worker",
    }),
    { accountId: "account", token: "token", workerName: "ci-worker" },
  );
});

test("uploads only code and never sends configuration metadata", async () => {
  const calls = [];
  await uploadWorker(
    "export default {}",
    { accountId: "account", token: "token", workerName: "worker" },
    async (url, init) => {
      calls.push(url);
      if (url.endsWith("/settings")) {
        assert.equal(init.method, undefined);
        return Response.json({
          success: true,
          result: {
            bindings: [
              {
                name: "STATUS_KV",
                type: "kv_namespace",
                namespace_id: "remote-only-id",
              },
            ],
          },
        });
      }
      assert.equal(init.method, "PUT");
      assert.ok(url.endsWith("/content"));
      assert.deepEqual([...init.body.keys()], ["metadata", "worker.mjs"]);
      assert.deepEqual(JSON.parse(await init.body.get("metadata").text()), {
        main_module: "worker.mjs",
      });
      assert.equal(
        await init.body.get("worker.mjs").text(),
        "export default {}",
      );
      return Response.json({ success: true, result: { id: "worker" } });
    },
  );
  assert.equal(calls.length, 2);
});

test("missing Dashboard binding prevents upload", async () => {
  let calls = 0;
  await assert.rejects(
    uploadWorker(
      "code",
      { accountId: "a", token: "t", workerName: "w" },
      async () => {
        calls++;
        return Response.json({ success: true, result: { bindings: [] } });
      },
    ),
    /bind STATUS_KV/,
  );
  assert.equal(calls, 1);
});

test("API errors stop deployment", async () => {
  await assert.rejects(
    uploadWorker(
      "code",
      { accountId: "a", token: "t", workerName: "w" },
      async () => Response.json({ success: false }, { status: 403 }),
    ),
    /HTTP 403/,
  );
});
