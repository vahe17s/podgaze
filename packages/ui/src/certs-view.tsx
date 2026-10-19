import { useEffect, useState } from "react";
import type { CertInfo, ClusterClient, ClusterSummary, ResourceRef } from "@podgaze/contracts";
import { GazeLoader } from "./loader";
import { ResourceTable, type TableColumn } from "./table";

type Row = CertInfo & { uid: string; status: string; days: number | null };

const sourceLabel: Record<CertInfo["source"], string> = {
  Certificate: "cert-manager",
  Secret: "TLS Secret",
  Webhook: "Webhook CA",
  APIService: "APIService CA",
  ExternalSecret: "External Secret",
  Kubeconfig: "Kubeconfig",
};

// Client certificates that log in to clusters, from every context in the kubeconfig.
function kubeconfigRows(clusters: ClusterSummary[]): CertInfo[] {
  return clusters.filter((cluster) => cluster.certExpires).map((cluster) => ({
    source: "Kubeconfig",
    namespace: "",
    name: cluster.name,
    secretName: "",
    certificateName: "",
    subject: cluster.server,
    dnsNames: [cluster.server],
    issuer: "",
    notAfter: cluster.certExpires!,
    renewalTime: "",
    ready: "",
    problem: "",
  }));
}

function daysLeft(notAfter: string, now: number): number | null {
  const at = Date.parse(notAfter);
  return Number.isNaN(at) ? null : Math.floor((at - now) / 86_400_000);
}

function expiryStatus(row: CertInfo, days: number | null): string {
  if (row.source === "ExternalSecret") return row.ready === "False" ? "Sync failing" : row.problem ? "Stale" : row.ready === "True" ? "Synced" : "Unknown";
  if (row.problem && days === null) return "Unreadable";
  if (days === null) return "Unknown";
  if (days < 0) return "Expired";
  if (days <= 7) return "Expires soon";
  if (days <= 30) return "Renew soon";
  if (row.ready === "False") return "NotReady";
  return "Valid";
}

const columns: TableColumn<Row>[] = [
  { key: "name", header: "Name", width: "1.1fr", cell: (row) => row.name },
  { key: "status", header: "Status", width: "0.7fr", cell: (row) => row.status, status: true },
  { key: "days", header: "Days left", width: "0.45fr", cell: (row) => (row.days === null ? "—" : String(row.days)) },
  { key: "expires", header: "Expires", width: "0.6fr", cell: (row) => (row.notAfter ? row.notAfter.slice(0, 10) : "—") },
  { key: "namespace", header: "Namespace", width: "0.7fr", cell: (row) => row.namespace },
  { key: "names", header: "For", width: "1.4fr", cell: (row) => row.problem || row.dnsNames.join(", ") || row.subject },
  { key: "issuer", header: "Issuer or store", width: "0.9fr", cell: (row) => row.issuer },
  { key: "source", header: "Kind", width: "0.75fr", cell: (row) => sourceLabel[row.source] },
];

// Every TLS certificate in view, soonest expiry first: cert-manager Certificates and plain TLS Secrets.
export function CertificatesView({ client, filter, refreshKey, onNavigate, clusters = [] }: { client: ClusterClient; filter: string; refreshKey: string; onNavigate: (ref: ResourceRef) => void; clusters?: ClusterSummary[] }) {
  const [certs, setCerts] = useState<CertInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soonOnly, setSoonOnly] = useState(false);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let gone = false;
    setError(null);
    client.listCertificates().then(
      (found) => {
        if (!gone) setCerts(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read certificates");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, refreshKey]);

  if (error) return <p className="empty-state" role="alert">{error}</p>;
  if (!certs) return <GazeLoader label="Reading certificates" detail="TLS Secrets, cert-manager, webhook CAs, and External Secrets" />;
  const needle = filter.trim().toLowerCase();
  const all = [...certs, ...kubeconfigRows(clusters)];
  const rows: Row[] = all.map((cert, index) => {
    const days = daysLeft(cert.notAfter, now);
    return { ...cert, days, status: expiryStatus(cert, days), uid: `${cert.source}/${cert.namespace}/${cert.name}/${index}` };
  })
    .filter((row) => !soonOnly || (row.days !== null && row.days <= 30) || row.status === "Sync failing" || row.status === "Stale")
    .filter((row) => !needle || [row.name, row.namespace, row.subject, row.issuer, ...row.dnsNames].some((text) => text.toLowerCase().includes(needle)));
  const expired = all.filter((cert) => (daysLeft(cert.notAfter, now) ?? 1) < 0).length;
  const syncing = all.filter((cert) => cert.source === "ExternalSecret" && cert.problem).length;
  const soon = all.filter((cert) => {
    const days = daysLeft(cert.notAfter, now);
    return days !== null && days >= 0 && days <= 30;
  }).length;

  return (
    <div className="argo-view">
      <div className="helm-toolbar">
        {expired ? <span className="chip bad-chip">{expired} expired</span> : null}
        {soon ? <span className="chip warn-chip">{soon} within 30 days</span> : null}
        {syncing ? <span className="chip bad-chip">{syncing} secret sync{syncing === 1 ? "" : "s"} failing</span> : null}
        {!expired && !soon && !syncing ? <span className="chip ok-chip">Nothing expires within 30 days</span> : null}
        <label className="check"><input type="checkbox" checked={soonOnly} onChange={(event) => setSoonOnly(event.target.checked)} /> Needs attention</label>
        <span className="muted">{all.length} items: TLS certificates, webhook and APIService CAs, External Secrets syncs, and kubeconfig logins. cert-manager renews its own; the rest need someone to.</span>
      </div>
      {rows.length === 0 ? <p className="empty-state">{all.length === 0 ? "Nothing with an expiry date here." : "Nothing matches."}</p> : (
        <ResourceTable
          rows={rows}
          tableId="Certificates"
          columns={columns}
          selectedUid={null}
          onSelect={(row) => {
            if (row.source === "Certificate") onNavigate({ kind: "certificates.cert-manager.io", namespace: row.namespace, name: row.name });
            else if (row.source === "Secret") onNavigate({ kind: "Secret", namespace: row.namespace, name: row.name });
            else if (row.source === "ExternalSecret") onNavigate({ kind: "externalsecrets.external-secrets.io", namespace: row.namespace, name: row.name });
          }}
        />
      )}
    </div>
  );
}
