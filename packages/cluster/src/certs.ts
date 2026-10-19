import { X509Certificate } from "node:crypto";
import type { CertInfo, WorkloadImages } from "@podgaze/contracts";

type Raw = Record<string, unknown>;

export type TlsSecretLike = {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  data?: Record<string, string>;
};

export type CertificateLike = {
  metadata?: { name?: string; namespace?: string };
  spec?: { secretName?: string; dnsNames?: string[]; commonName?: string; issuerRef?: { name?: string; kind?: string } };
  status?: { notAfter?: string; renewalTime?: string; conditions?: { type?: string; status?: string; message?: string }[] };
};

function cn(distinguished: string): string {
  const match = /CN=([^\n,]+)/.exec(distinguished);
  return match ? match[1]!.trim() : distinguished.split("\n")[0] ?? "";
}

// The leaf certificate of a tls.crt chain: who it is for, who issued it, and when it stops working.
export function readTlsCertificate(base64Pem: string | undefined): { subject: string; dnsNames: string[]; issuer: string; notAfter: string } | { problem: string } {
  if (!base64Pem) return { problem: "No tls.crt in this Secret." };
  try {
    const pem = Buffer.from(base64Pem, "base64").toString("utf8");
    const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!first) return { problem: "tls.crt is not a PEM certificate." };
    const cert = new X509Certificate(first);
    return {
      subject: cn(cert.subject),
      dnsNames: (cert.subjectAltName ?? "").split(",").map((item) => item.trim()).filter((item) => item.startsWith("DNS:")).map((item) => item.slice(4)),
      issuer: cn(cert.issuer),
      notAfter: new Date(cert.validTo).toISOString(),
    };
  } catch (error) {
    return { problem: `tls.crt could not be read: ${error instanceof Error ? error.message : "unknown error"}.` };
  }
}

function readyOf(certificate: CertificateLike): { ready: string; problem: string } {
  const ready = certificate.status?.conditions?.find((item) => item.type === "Ready");
  if (!ready) return { ready: "Unknown", problem: "" };
  return { ready: ready.status === "True" ? "True" : "False", problem: ready.status === "True" ? "" : ready.message ?? "" };
}

// cert-manager Certificates, plus TLS Secrets that no Certificate manages (installed by hand or by a chart).
export function certificateRows(secrets: TlsSecretLike[], certificates: CertificateLike[]): CertInfo[] {
  const parsed = new Map<string, ReturnType<typeof readTlsCertificate>>();
  for (const secret of secrets) parsed.set(`${secret.metadata?.namespace}/${secret.metadata?.name}`, readTlsCertificate(secret.data?.["tls.crt"]));
  const managed = new Set<string>();
  const rows: CertInfo[] = [];
  for (const certificate of certificates) {
    const namespace = certificate.metadata?.namespace ?? "";
    const secretName = certificate.spec?.secretName ?? "";
    managed.add(`${namespace}/${secretName}`);
    const fromSecret = parsed.get(`${namespace}/${secretName}`);
    const leaf = fromSecret && !("problem" in fromSecret) ? fromSecret : null;
    const state = readyOf(certificate);
    rows.push({
      source: "Certificate",
      namespace,
      name: certificate.metadata?.name ?? "",
      secretName,
      certificateName: certificate.metadata?.name ?? "",
      subject: leaf?.subject ?? certificate.spec?.commonName ?? certificate.spec?.dnsNames?.[0] ?? "",
      dnsNames: certificate.spec?.dnsNames ?? leaf?.dnsNames ?? [],
      issuer: certificate.spec?.issuerRef?.name ? `${certificate.spec.issuerRef.kind ?? "Issuer"}/${certificate.spec.issuerRef.name}` : leaf?.issuer ?? "",
      notAfter: certificate.status?.notAfter ? new Date(certificate.status.notAfter).toISOString() : leaf?.notAfter ?? "",
      renewalTime: certificate.status?.renewalTime ? new Date(certificate.status.renewalTime).toISOString() : "",
      ready: state.ready,
      problem: state.problem || (fromSecret && "problem" in fromSecret && !certificate.status?.notAfter ? fromSecret.problem : ""),
    });
  }
  for (const secret of secrets) {
    const namespace = secret.metadata?.namespace ?? "";
    const name = secret.metadata?.name ?? "";
    if (managed.has(`${namespace}/${name}`)) continue;
    const leaf = parsed.get(`${namespace}/${name}`)!;
    const ok = !("problem" in leaf);
    rows.push({
      source: "Secret",
      namespace,
      name,
      secretName: name,
      certificateName: secret.metadata?.annotations?.["cert-manager.io/certificate-name"] ?? "",
      subject: ok ? leaf.subject : "",
      dnsNames: ok ? leaf.dnsNames : [],
      issuer: ok ? leaf.issuer : "",
      notAfter: ok ? leaf.notAfter : "",
      renewalTime: "",
      ready: "",
      problem: ok ? "" : leaf.problem,
    });
  }
  return rows.sort((left, right) => (left.notAfter || "9999").localeCompare(right.notAfter || "9999"));
}

type PodTemplateHolder = { metadata?: { name?: string; namespace?: string }; spec?: Raw };

function containersOf(spec: Raw | undefined, cron: boolean): { name: string; image: string }[] {
  const template = cron ? ((((spec?.jobTemplate as Raw | undefined)?.spec as Raw | undefined)?.template as Raw | undefined)) : (spec?.template as Raw | undefined);
  const podSpec = (template?.spec ?? {}) as { containers?: { name?: string; image?: string }[]; initContainers?: { name?: string; image?: string }[] };
  return [...(podSpec.initContainers ?? []), ...(podSpec.containers ?? [])].map((item) => ({ name: item.name ?? "", image: item.image ?? "" })).filter((item) => item.image);
}

export function workloadImages(kind: string, items: PodTemplateHolder[]): WorkloadImages[] {
  return items.map((item) => ({
    kind,
    namespace: item.metadata?.namespace ?? "",
    name: item.metadata?.name ?? "",
    containers: containersOf(item.spec, kind === "CronJob"),
  })).filter((item) => item.name && item.containers.length > 0);
}

export type CaBundleHolder = {
  kind?: string;
  metadata?: { name?: string };
  webhooks?: { name?: string; clientConfig?: { caBundle?: string; service?: { namespace?: string; name?: string } } }[];
  spec?: { caBundle?: string; service?: { namespace?: string; name?: string } };
};

// The CA a webhook or aggregated API is trusted with. When it expires, every request through it fails.
export function caBundleRows(items: CaBundleHolder[], source: "Webhook" | "APIService"): CertInfo[] {
  return items.flatMap((item) => {
    const bundles = source === "Webhook"
      ? (item.webhooks ?? []).map((hook) => ({ ca: hook.clientConfig?.caBundle, service: hook.clientConfig?.service }))
      : [{ ca: item.spec?.caBundle, service: item.spec?.service }];
    const read = bundles.filter((bundle) => bundle.ca).map((bundle) => ({ ...bundle, leaf: readTlsCertificate(bundle.ca) }));
    if (read.length === 0) return [];
    const valid = read.flatMap((bundle) => ("problem" in bundle.leaf ? [] : [{ ...bundle, leaf: bundle.leaf }]));
    const soonest = valid.sort((left, right) => left.leaf.notAfter.localeCompare(right.leaf.notAfter))[0];
    const services = [...new Set(read.map((bundle) => (bundle.service?.name ? `${bundle.service.namespace}/${bundle.service.name}` : "")).filter(Boolean))];
    const problem = soonest ? "" : "problem" in read[0]!.leaf ? read[0]!.leaf.problem : "";
    return [{
      source,
      namespace: "",
      name: item.metadata?.name ?? "",
      secretName: "",
      certificateName: "",
      subject: soonest?.leaf.subject ?? "",
      dnsNames: services,
      issuer: soonest?.leaf.issuer ?? "",
      notAfter: soonest?.leaf.notAfter ?? "",
      renewalTime: "",
      ready: "",
      problem,
    }];
  });
}

export type ExternalSecretLike = {
  metadata?: { name?: string; namespace?: string };
  spec?: { refreshInterval?: string; target?: { name?: string }; secretStoreRef?: { kind?: string; name?: string } };
  status?: { refreshTime?: string; conditions?: { type?: string; status?: string; message?: string; reason?: string }[] };
};

export function durationMs(text: string | undefined): number | null {
  if (!text) return null;
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (parts.length === 0) return null;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2]!]!, 0);
}

// External Secrets that stopped syncing from their store (Key Vault, AWS Secrets Manager, Vault): the Secret in the
// cluster silently goes out of date when the value is rotated at the source.
export function externalSecretRows(items: ExternalSecretLike[], now = Date.now()): CertInfo[] {
  return items.map((item) => {
    const ready = item.status?.conditions?.find((condition) => condition.type === "Ready");
    const interval = durationMs(item.spec?.refreshInterval);
    const refreshed = item.status?.refreshTime ? Date.parse(item.status.refreshTime) : NaN;
    let problem = ready?.status === "False" ? ready.message || ready.reason || "Sync failing" : "";
    if (!problem && interval && interval > 0 && Number.isFinite(refreshed) && now - refreshed > interval * 3) {
      problem = `Stale: last synced ${Math.round((now - refreshed) / 3_600_000)}h ago, refresh is every ${item.spec?.refreshInterval}.`;
    }
    const store = item.spec?.secretStoreRef;
    return {
      source: "ExternalSecret" as const,
      namespace: item.metadata?.namespace ?? "",
      name: item.metadata?.name ?? "",
      secretName: item.spec?.target?.name || item.metadata?.name || "",
      certificateName: "",
      subject: item.spec?.target?.name || item.metadata?.name || "",
      dnsNames: [],
      issuer: store?.name ? `${store.kind ?? "SecretStore"}/${store.name}` : "",
      notAfter: "",
      renewalTime: Number.isFinite(refreshed) ? new Date(refreshed).toISOString() : "",
      ready: ready?.status === "True" ? "True" : ready?.status === "False" ? "False" : "Unknown",
      problem,
    };
  });
}
