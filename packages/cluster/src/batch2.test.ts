import { createPriceLookup, azureHourly } from "./prices.js";
import { describe, expect, it } from "vitest";
import { addClusterSteps, contextNameFor, createCloud, parseAksClusters, parseAwsProfiles, parseAzureAccounts, parseEksClusters, parseGkeClusters } from "./cloud.js";
import { caBundleRows, certificateRows, durationMs, externalSecretRows, readTlsCertificate, workloadImages } from "./certs.js";
import { podAlert } from "./hub.js";
import { buildMap, serviceForHost } from "./map.js";
import { daemonSetStatus, rerunJobBody, setImagePatch, statefulSetStatus } from "./workload-commands.js";
import { shellCommand } from "./commands.js";

// Self-signed for shop.example.com, valid until 2026-11-15.
const PEM = `-----BEGIN CERTIFICATE-----
MIIBvzCCAWagAwIBAgIUP9/bBtrkFePH54TO+YWUqbqXsacwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQc2hvcC5leGFtcGxlLmNvbTAeFw0yNjEwMTYwNzQxNDlaFw0y
NjExMTUwNzQxNDlaMBsxGTAXBgNVBAMMEHNob3AuZXhhbXBsZS5jb20wWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAASt6bmsHqgeFkLuvZU0ckCGpdzRiXXV6TWqxdnh
8rwzjrti1p5o4mBKBQj4IZfnKKjsjyCrDMZqmgxIUzJVKDSbo4GHMIGEMB0GA1Ud
DgQWBBRg1MetH46zwTvS4PHXQ6GFhpDx3zAfBgNVHSMEGDAWgBRg1MetH46zwTvS
4PHXQ6GFhpDx3zAPBgNVHRMBAf8EBTADAQH/MDEGA1UdEQQqMCiCEHNob3AuZXhh
bXBsZS5jb22CFHd3dy5zaG9wLmV4YW1wbGUuY29tMAoGCCqGSM49BAMCA0cAMEQC
IEhflu4a7IAlXjG67P+X4jcxAAqRQhnmgNI9rGAlmro+AiARuX+eXgtZ/XTRrH9b
jmdTz7Bvm4TVjTuvSFRMnHYeDg==
-----END CERTIFICATE-----`;
const pemData = Buffer.from(PEM).toString("base64");

describe("workload commands", () => {
  const workload = { spec: { template: { spec: { containers: [{ name: "app", image: "a:1" }, { name: "sidecar", image: "s:1" }], initContainers: [{ name: "migrate", image: "m:1" }] } } } };

  it("patches the right container image", () => {
    expect(setImagePatch(workload, "sidecar", "s:2")).toEqual([{ op: "replace", path: "/spec/template/spec/containers/1/image", value: "s:2" }]);
    expect(setImagePatch(workload, "migrate", "m:2")).toEqual([{ op: "replace", path: "/spec/template/spec/initContainers/0/image", value: "m:2" }]);
    expect(() => setImagePatch(workload, undefined, "x:1")).toThrow(/Choose a container: app, sidecar/);
    expect(() => setImagePatch(workload, "app", " ")).toThrow(/needs the new image/);
  });

  it("copies a Job for a rerun without the controller's labels and selector", () => {
    const body = rerunJobBody({
      metadata: { name: "migrate", namespace: "shop", labels: { app: "db", "controller-uid": "u1" } },
      spec: { selector: { matchLabels: { "controller-uid": "u1" } }, template: { metadata: { labels: { "job-name": "migrate", app: "db", "batch.kubernetes.io/controller-uid": "u1" } } }, suspend: true } as never,
    }, 1_700_000_000_000);
    expect(body.metadata.name).toMatch(/^migrate-rerun-/);
    expect(body.metadata.labels).toEqual({ app: "db" });
    expect(body.spec).not.toHaveProperty("selector");
    expect((body.spec.template as { metadata: { labels: Record<string, string> } }).metadata.labels).toEqual({ app: "db" });
    expect(body.spec.suspend).toBe(false);
  });

  it("reports StatefulSet and DaemonSet rollouts the way kubectl does", () => {
    expect(statefulSetStatus("db", { spec: { replicas: 3 }, status: { readyReplicas: 3, updatedReplicas: 3, currentRevision: "r2", updateRevision: "r2" } })).toBe("statefulset rolling update complete 3 pods at revision r2");
    expect(daemonSetStatus("agent", { status: { desiredNumberScheduled: 4, updatedNumberScheduled: 2, numberAvailable: 4 } })).toMatch(/2 out of 4 new pods/);
  });

  it("writes kubectl lines for the new commands", () => {
    expect(shellCommand({ name: "rollout-restart", kind: "StatefulSet", resourceName: "db", namespace: "shop" })).toBe("kubectl rollout restart statefulset/db -n shop");
    expect(shellCommand({ name: "set-image", kind: "Deployment", resourceName: "api", namespace: "shop", container: "app", image: "api:2" })).toBe("kubectl set image deployment/api app=api:2 -n shop");
    expect(shellCommand({ name: "force-delete", kind: "Pod", resourceName: "api-1", namespace: "shop" })).toBe("kubectl delete pod api-1 -n shop --grace-period=0 --force");
    expect(shellCommand({ name: "suspend", kind: "Job", resourceName: "migrate", namespace: "shop" })).toContain("kubectl patch job migrate");
    expect(shellCommand({ name: "scale", kind: "StatefulSet", resourceName: "db", namespace: "shop", replicas: 2 })).toBe("kubectl scale statefulset/db -n shop --replicas=2");
  });
});

describe("certificates", () => {
  it("reads the leaf certificate of a TLS secret", () => {
    expect(readTlsCertificate(pemData)).toEqual({ subject: "shop.example.com", dnsNames: ["shop.example.com", "www.shop.example.com"], issuer: "shop.example.com", notAfter: expect.stringMatching(/^2026-11-15/) });
    expect(readTlsCertificate(Buffer.from("junk").toString("base64"))).toEqual({ problem: "tls.crt is not a PEM certificate." });
  });

  it("lists Certificates once and unmanaged TLS Secrets on their own, soonest expiry first", () => {
    const rows = certificateRows(
      [
        { metadata: { name: "shop-tls", namespace: "shop" }, data: { "tls.crt": pemData } },
        { metadata: { name: "legacy", namespace: "shop" }, data: { "tls.crt": pemData } },
      ],
      [{ metadata: { name: "shop", namespace: "shop" }, spec: { secretName: "shop-tls", dnsNames: ["shop.example.com"], issuerRef: { kind: "ClusterIssuer", name: "letsencrypt" } }, status: { notAfter: "2026-10-20T00:00:00Z", conditions: [{ type: "Ready", status: "True" }] } }],
    );
    expect(rows.map((row) => [row.source, row.name, row.notAfter.slice(0, 10)])).toEqual([
      ["Certificate", "shop", "2026-10-20"],
      ["Secret", "legacy", "2026-11-15"],
    ]);
    expect(rows[0]).toMatchObject({ issuer: "ClusterIssuer/letsencrypt", ready: "True", secretName: "shop-tls" });
  });
});

describe("images", () => {
  it("lists containers of workloads, including CronJob templates", () => {
    expect(workloadImages("CronJob", [{ metadata: { name: "report", namespace: "ops" }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "run", image: "report:3" }] } } } } } }]))
      .toEqual([{ kind: "CronJob", namespace: "ops", name: "report", containers: [{ name: "run", image: "report:3" }] }]);
  });
});

describe("istio on the map", () => {
  it("resolves service hosts and links gateway, virtual service, and destination rule", () => {
    expect(serviceForHost("reviews", "shop")).toEqual({ name: "reviews", namespace: "shop" });
    expect(serviceForHost("reviews.other.svc.cluster.local", "shop")).toEqual({ name: "reviews", namespace: "other" });
    expect(serviceForHost("api.example.com", "shop")).toBeNull();
    const map = buildMap({
      Service: [{ metadata: { name: "api", namespace: "shop", uid: "s" } }, { metadata: { name: "web", namespace: "shop", uid: "w" } }],
      Gateway: [{ metadata: { name: "public", namespace: "istio-ingress", uid: "g" } }],
      VirtualService: [
        { metadata: { name: "api", namespace: "shop", uid: "v1" }, spec: { gateways: ["istio-ingress/public", "mesh"], http: [{ route: [{ destination: { host: "api" } }] }] } },
        { metadata: { name: "web", namespace: "shop", uid: "v2" }, spec: { gateways: ["istio-ingress/public"], http: [{ route: [{ destination: { host: "web.shop.svc.cluster.local" } }] }] } },
      ],
      DestinationRule: [{ metadata: { name: "api", namespace: "shop", uid: "d" }, spec: { host: "api" } }],
    }, { istio: { Gateway: "gateways.networking.istio.io", VirtualService: "virtualservices.networking.istio.io", DestinationRule: "destinationrules.networking.istio.io" } });
    const edges = map.edges.map((edge) => `${edge.from} ${edge.relation} ${edge.to}`);
    expect(edges).toEqual(expect.arrayContaining([
      "gateways.networking.istio.io/istio-ingress/public routes to virtualservices.networking.istio.io/shop/api",
      "virtualservices.networking.istio.io/shop/api routes to Service/shop/api",
      "destinationrules.networking.istio.io/shop/api configures Service/shop/api",
      "virtualservices.networking.istio.io/shop/web routes to Service/shop/web",
    ]));
    const group = (id: string) => map.nodes.find((node) => node.id === id)!.group;
    // The shared gateway does not merge the two apps.
    expect(group("Service/shop/api")).not.toBe(group("Service/shop/web"));
  });
});

describe("alerts", () => {
  const pod = (status: string, restarts = 0, lastExit = "") => ({ uid: "p", name: "api", namespace: "shop", status, restarts, lastExit } as never);
  it("fires on a move into a failing state and on a new OOM kill", () => {
    expect(podAlert(pod("Running"), pod("CrashLoopBackOff", 3, "Error (1)"))).toMatchObject({ reason: "CrashLoopBackOff" });
    expect(podAlert(pod("CrashLoopBackOff"), pod("CrashLoopBackOff"))).toBeNull();
    expect(podAlert(pod("Running", 1, "OOMKilled (137)"), pod("Running", 2, "OOMKilled (137)"))).toMatchObject({ reason: "OOMKilled" });
    expect(podAlert(pod("Running"), pod("Running"))).toBeNull();
  });
});

describe("cloud CLIs", () => {
  it("parses each cloud's own listings", () => {
    expect(parseAzureAccounts('[{"id":"s2","name":"Dev","isDefault":false},{"id":"s1","name":"Prod","isDefault":true},{"id":"s3","name":"Old","state":"Disabled"}]').map((item) => item.name)).toEqual(["Prod", "Dev"]);
    expect(parseAksClusters('[{"name":"aks-dev","resourceGroup":"rg","location":"westeurope","currentKubernetesVersion":"1.30.3","powerState":{"code":"Running"},"aadProfile":{}}]', "s1")[0])
      .toEqual({ provider: "azure", name: "aks-dev", group: "rg", location: "westeurope", version: "1.30.3", state: "Running", note: "Entra ID", accountId: "s1" });
    expect(parseAwsProfiles("default\nteam-a\n", "team-a").map((item) => [item.name, item.isDefault])).toEqual([["team-a", true], ["default", false]]);
    expect(parseEksClusters('{"clusters":["payments","shop"]}', "team-a", "eu-west-1").map((item) => [item.name, item.group])).toEqual([["payments", "eu-west-1"], ["shop", "eu-west-1"]]);
    expect(parseGkeClusters('[{"name":"web","location":"europe-west1","currentMasterVersion":"1.30.4","status":"RUNNING"}]', "proj")[0]).toMatchObject({ provider: "gcp", group: "europe-west1", state: "RUNNING" });
  });

  it("builds the get-credentials command for each cloud and refuses odd names", () => {
    const line = (request: Parameters<typeof addClusterSteps>[0]) => addClusterSteps(request, "/home/me/.kube/config").map((step) => [step.command, ...step.args].join(" "));
    expect(line({ provider: "azure", accountId: "s1", group: "rg", name: "aks-dev", azureCliLogin: true })).toEqual([
      "az aks get-credentials --resource-group rg --name aks-dev --subscription s1 --file /home/me/.kube/config --overwrite-existing",
      "kubelogin convert-kubeconfig -l azurecli --kubeconfig /home/me/.kube/config --context aks-dev",
    ]);
    expect(line({ provider: "aws", accountId: "team-a", group: "eu-west-1", name: "shop" })).toEqual([
      "aws eks update-kubeconfig --name shop --region eu-west-1 --profile team-a --kubeconfig /home/me/.kube/config --alias shop",
    ]);
    const gke = addClusterSteps({ provider: "gcp", accountId: "proj", group: "europe-west1", name: "web" }, "/k");
    expect(gke[0]).toEqual({ command: "gcloud", args: ["container", "clusters", "get-credentials", "web", "--location", "europe-west1", "--project", "proj"], env: { KUBECONFIG: "/k" } });
    expect(contextNameFor({ provider: "gcp", accountId: "proj", group: "europe-west1", name: "web" })).toBe("gke_proj_europe-west1_web");
    expect(() => addClusterSteps({ provider: "azure", accountId: "s1", group: "rg; rm -rf /", name: "x" }, "/k")).toThrow(/cloud name/);
  });

  it("keeps going without kubelogin, and passes KUBECONFIG to gcloud", async () => {
    const calls: { command: string; env?: Record<string, string> }[] = [];
    const cloud = createCloud(async (command, _args, options) => {
      calls.push({ command, env: options?.env });
      if (command === "kubelogin") throw new Error("kubelogin is not installed or not on PATH.");
      return "";
    });
    const added = await cloud.add({ provider: "azure", accountId: "s1", group: "rg", name: "aks-dev", azureCliLogin: true }, "/k");
    expect(calls.map((call) => call.command)).toEqual(["az", "kubelogin"]);
    expect(added.message).toMatch(/device-code/);
    await cloud.add({ provider: "gcp", accountId: "proj", group: "europe-west1", name: "web" }, "/k");
    expect(calls.at(-1)).toEqual({ command: "gcloud", env: { KUBECONFIG: "/k" } });
  });
});

describe("VM prices", () => {
  const items = [
    { type: "Consumption", unitOfMeasure: "1 Hour", retailPrice: 0.192, skuName: "D4s v5", productName: "Virtual Machines Dsv5 Series" },
    { type: "Consumption", unitOfMeasure: "1 Hour", retailPrice: 0.376, skuName: "D4s v5", productName: "Virtual Machines Dsv5 Series Windows" },
    { type: "Consumption", unitOfMeasure: "1 Hour", retailPrice: 0.0384, skuName: "D4s v5 Spot", productName: "Virtual Machines Dsv5 Series" },
    { type: "Consumption", unitOfMeasure: "1 Hour", retailPrice: 0.0384, skuName: "D4s v5 Low Priority", productName: "Virtual Machines Dsv5 Series" },
  ];

  it("picks the Linux pay-as-you-go or Spot price", () => {
    expect(azureHourly(items, false)).toBe(0.192);
    expect(azureHourly(items, true)).toBe(0.0384);
  });

  it("asks Azure only for safe names and only for Azure sizes", async () => {
    const urls: string[] = [];
    const lookup = createPriceLookup(async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ Items: items }) };
    });
    const quotes = await lookup([
      { region: "westeurope", instanceType: "Standard_D4s_v5", spot: false },
      { region: "eu-west-1", instanceType: "m5.large", spot: false },
      { region: "westeurope' or 1 eq 1", instanceType: "Standard_D4s_v5", spot: false },
    ]);
    expect(quotes.map((quote) => quote.hourly)).toEqual([0.192, null, null]);
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0]!)).toContain("armSkuName eq 'Standard_D4s_v5'");
  });
});

describe("expiry radar", () => {
  it("reads webhook and APIService CA bundles", () => {
    const rows = caBundleRows([
      { kind: "ValidatingWebhookConfiguration", metadata: { name: "policy" }, webhooks: [{ clientConfig: { caBundle: pemData, service: { namespace: "gatekeeper", name: "webhook" } } }] },
      { metadata: { name: "no-ca" }, webhooks: [{ clientConfig: {} }] },
    ], "Webhook");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "Webhook", name: "policy", dnsNames: ["gatekeeper/webhook"], problem: "" });
    expect(rows[0]!.notAfter).toBe((readTlsCertificate(pemData) as { notAfter: string }).notAfter);
    expect(caBundleRows([{ metadata: { name: "v1beta1.metrics.k8s.io" }, spec: { caBundle: Buffer.from("junk").toString("base64") } }], "APIService")[0]!.problem).toContain("not a PEM");
  });

  it("flags External Secrets that fail or stopped refreshing", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const rows = externalSecretRows([
      { metadata: { name: "db", namespace: "shop" }, spec: { refreshInterval: "1h", secretStoreRef: { kind: "ClusterSecretStore", name: "key-vault" } }, status: { refreshTime: "2026-10-16T11:30:00Z", conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "api", namespace: "shop" }, spec: { refreshInterval: "15m" }, status: { refreshTime: "2026-10-16T08:00:00Z", conditions: [{ type: "Ready", status: "True" }] } },
      { metadata: { name: "broken", namespace: "shop" }, status: { conditions: [{ type: "Ready", status: "False", message: "could not get secret data from provider" }] } },
    ], now);
    expect(rows.map((row) => [row.name, row.ready, row.problem.split(":")[0]])).toEqual([["db", "True", ""], ["api", "True", "Stale"], ["broken", "False", "could not get secret data from provider"]]);
    expect(rows[0]!.issuer).toBe("ClusterSecretStore/key-vault");
    expect(durationMs("1h30m")).toBe(5_400_000);
    expect(durationMs("0")).toBeNull();
  });
});
