import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { prepareOpeningE2eStorage } from "../../scripts/opening-e2e/storage.mjs";

async function storageFixture(t, headStatus) {
  const requests = [];
  let object = Buffer.alloc(0);
  const origin = "http://127.0.0.1:3100";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "HEAD") { response.writeHead(headStatus); response.end(); return; }
    if (request.method === "OPTIONS") {
      response.writeHead(200, { "access-control-allow-origin": origin }); response.end(); return;
    }
    if (request.method === "PUT" && url.pathname !== "/opening-e2e/") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      object = Buffer.concat(chunks);
    }
    response.writeHead(200);
    response.end(request.method === "GET" ? object : undefined);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { requests, env: {
    S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`, S3_REGION: "us-east-1", S3_BUCKET: "opening-e2e",
    S3_ACCESS_KEY_ID: "fixture", S3_SECRET_ACCESS_KEY: "fixture", PUBLIC_BASE_URL: origin,
  } };
}

test("first start creates an absent bucket and verifies real bytes through the S3 client", async (t) => {
  const { env, requests } = await storageFixture(t, 404);
  await prepareOpeningE2eStorage(env);
  assert.equal(requests.filter((request) => request === "PUT /opening-e2e/").length, 1);
  const upload = requests.find((request) => request.startsWith("PUT /opening-e2e/acceptance-probes/"));
  assert.ok(upload);
  assert.ok(requests.includes(upload.replace("PUT ", "GET ")));
  assert.ok(requests.includes(upload.replace("PUT ", "DELETE ")));
});

test("existing buckets are probed without being recreated", async (t) => {
  const { env, requests } = await storageFixture(t, 200);
  await prepareOpeningE2eStorage(env);
  assert.ok(!requests.includes("PUT /opening-e2e/"));
});

test("denied bucket access fails before creating or writing any objects", async (t) => {
  const { env, requests } = await storageFixture(t, 403);
  await assert.rejects(prepareOpeningE2eStorage(env));
  assert.deepEqual(requests, ["HEAD /opening-e2e/"]);
});
