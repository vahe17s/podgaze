import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCustomKinds } from "@podgaze/contracts";
import { crdEntries } from "./custom-kinds.js";
import { createKubeBackend } from "./kube-backend.js";

// A fake API server that pages a custom resource list without remainingItemCount, like a list served from the watch cache.
const total = 7;
let server: http.Server;
let lastPatch: { contentType: string; body: unknown } | null = null;
let kubeconfig: string;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/namespaces/shop/secrets/api") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        if (request.method === "PATCH") lastPatch = { contentType: String(request.headers["content-type"]), body: JSON.parse(raw) };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          apiVersion: "v1", kind: "Secret", type: "Opaque",
          metadata: { name: "api", namespace: "shop", resourceVersion: request.method === "PATCH" ? "8" : "7" },
          data: request.method === "PATCH" ? { TOKEN: Buffer.from("new").toString("base64") } : { TOKEN: "b2xk", OLD: "eA==" },
        }));
      });
      return;
    }
    if (!url.pathname.endsWith("/virtualservices")) {
      response.writeHead(404).end();
      return;
    }
    const limit = Number(url.searchParams.get("limit") ?? total);
    const start = Number(url.searchParams.get("continue") || 0);
    const end = Math.min(total, start + limit);
    const items = Array.from({ length: end - start }, (_, index) => ({
      apiVersion: "networking.istio.io/v1",
      kind: "VirtualService",
      metadata: { name: `vs-${start + index}`, namespace: "development", uid: `u${start + index}` },
    }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      apiVersion: "networking.istio.io/v1",
      kind: "VirtualServiceList",
      metadata: { resourceVersion: "42", ...(end < total ? { continue: String(end) } : {}) },
      items,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  kubeconfig = path.join(os.tmpdir(), `podgaze-paging-${Date.now()}.yaml`);
  fs.writeFileSync(kubeconfig, `apiVersion: v1
kind: Config
clusters:
- name: fake
  cluster:
    server: http://127.0.0.1:${port}
    insecure-skip-tls-verify: true
contexts:
- name: fake
  context: { cluster: fake, user: fake }
users:
- name: fake
  user: { token: t }
current-context: fake
`);
  registerCustomKinds(crdEntries([{ spec: { group: "networking.istio.io", scope: "Namespaced", names: { kind: "VirtualService", plural: "virtualservices" }, versions: [{ name: "v1", served: true, storage: true }] } }]));
});

afterAll(() => {
  server.close();
  fs.rmSync(kubeconfig, { force: true });
});

describe("custom resource paging against a real client", () => {
  it("counts every object when the server leaves out remainingItemCount", async () => {
    const backend = createKubeBackend(kubeconfig, "fake");
    expect(await backend.countResources!("virtualservices.networking.istio.io", "development")).toBe(total);
  });

  it("lists past the first page", async () => {
    const backend = createKubeBackend(kubeconfig, "fake");
    const listed = await backend.listResources("virtualservices.networking.istio.io", "development");
    expect(listed.rows.map((row) => row.name)).toEqual(Array.from({ length: total }, (_, index) => `vs-${index}`));
    expect(listed.resourceVersion).toBe("42");
  });
});

describe("secret write against a real client", () => {
  it("sends a JSON merge patch whose null removes a key", async () => {
    const backend = createKubeBackend(kubeconfig, "fake");
    const saved = await backend.writeSecret!({ namespace: "shop", name: "api", resourceVersion: "7", set: [{ key: "TOKEN", value: "new", encoding: "text" }], remove: ["OLD"] });
    expect(lastPatch?.contentType).toContain("application/merge-patch+json");
    expect(lastPatch?.body).toEqual({ metadata: { resourceVersion: "7" }, data: { TOKEN: "bmV3", OLD: null } });
    expect(saved.values).toEqual([{ key: "TOKEN", value: "new", binary: false, encoded: "bmV3" }]);
    expect(saved.resourceVersion).toBe("8");
  });
});
