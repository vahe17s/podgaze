import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ClusterClient, CloudAccount, CloudCluster, CloudProvider } from "@podgaze/contracts";
import { Icon } from "./icons";
import { GazeInline } from "./loader";

const providers: { id: CloudProvider; label: string; account: string; cli: string; command: string }[] = [
  { id: "azure", label: "Azure (AKS)", account: "Subscription", cli: "az login", command: "az aks get-credentials" },
  { id: "aws", label: "AWS (EKS)", account: "Profile", cli: "aws configure or aws sso login", command: "aws eks update-kubeconfig" },
  { id: "gcp", label: "Google Cloud (GKE)", account: "Project", cli: "gcloud auth login", command: "gcloud container clusters get-credentials" },
];

// Adds managed clusters to the kubeconfig through each cloud's own CLI, using whatever account it is signed in to.
// Podgaze lists what that CLI can see; nothing about any account is built in.
export function CloudDialog({ client, onAdded, onClose }: { client: ClusterClient; onAdded: () => void; onClose: () => void }) {
  const [provider, setProvider] = useState<CloudProvider>("azure");
  const [accounts, setAccounts] = useState<CloudAccount[] | null>(null);
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("");
  const [clusters, setClusters] = useState<CloudCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cliLogin, setCliLogin] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<{ name: string; message: string }[]>([]);
  const [query, setQuery] = useState("");
  const info = providers.find((item) => item.id === provider)!;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let gone = false;
    setAccounts(null);
    setAccount("");
    setClusters(null);
    setError(null);
    client.cloudAccounts(provider).then(
      (found) => {
        if (gone) return;
        setAccounts(found);
        setAccount(found.find((item) => item.isDefault)?.id ?? found[0]?.id ?? "");
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not run the cloud CLI");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, provider]);

  // EKS clusters live per region; start from the profile's configured region.
  useEffect(() => {
    if (provider !== "aws" || !account) return;
    let gone = false;
    client.cloudDefaultRegion(account).then((found) => {
      if (!gone) setRegion((current) => current || found);
    }, () => undefined);
    return () => {
      gone = true;
    };
  }, [client, provider, account]);

  useEffect(() => {
    if (!account || (provider === "aws" && !region.trim())) return;
    let gone = false;
    setClusters(null);
    setError(null);
    const timer = window.setTimeout(() => {
      client.cloudClusters(provider, account, provider === "aws" ? region.trim() : undefined).then(
        (found) => {
          if (!gone) setClusters(found);
        },
        (reason: unknown) => {
          if (!gone) setError(reason instanceof Error ? reason.message : "Could not list clusters");
        },
      );
    }, provider === "aws" ? 400 : 0);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [client, provider, account, region]);

  async function add(cluster: CloudCluster) {
    setAdding(cluster.name);
    setError(null);
    try {
      const result = await client.cloudAddCluster({
        provider: cluster.provider,
        accountId: cluster.accountId,
        group: cluster.group,
        name: cluster.name,
        ...(cluster.provider === "azure" ? { azureCliLogin: cliLogin && cluster.note === "Entra ID" } : {}),
      });
      setAdded((current) => [...current, { name: result.context, message: result.message }]);
      onAdded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add the cluster");
    } finally {
      setAdding(null);
    }
  }

  const needle = query.trim().toLowerCase();
  const shown = (clusters ?? []).filter((cluster) => !needle || `${cluster.name} ${cluster.group} ${cluster.location}`.toLowerCase().includes(needle));
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="context-panel aks-dialog" role="dialog" aria-modal="true" aria-label="Add cloud cluster" onMouseDown={(event) => event.stopPropagation()}>
        <header className="context-head">
          <div>
            <p className="eyebrow">Cloud</p>
            <h2>Add clusters from a cloud account</h2>
            <p className="muted">Uses the cloud CLI on this computer and the account it is signed in to (<code>{info.cli}</code>), then writes the context into your kubeconfig like <code>{info.command}</code>.</p>
          </div>
          <button type="button" className="dock-icon ghost" aria-label="Close Add cloud cluster" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="segmented" role="group" aria-label="Cloud">
          {providers.map((item) => (
            <button key={item.id} type="button" aria-pressed={provider === item.id} onClick={() => {
              setProvider(item.id);
              setRegion("");
              setQuery("");
            }}>{item.label}</button>
          ))}
        </div>
        {!accounts && !error ? <GazeInline label={`Asking ${info.cli.split(" ")[0]} for your ${info.account.toLowerCase()}s…`} /> : null}
        {accounts && accounts.length === 0 ? <p className="muted">The CLI lists no {info.account.toLowerCase()}s. Sign in with <code>{info.cli}</code> first.</p> : null}
        {accounts && accounts.length > 0 ? (
          <div className="aks-tools">
            <label className="field">
              {info.account}
              <select aria-label={info.account} value={account} onChange={(event) => setAccount(event.target.value)}>
                {accounts.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? " (default)" : ""}</option>)}
              </select>
            </label>
            {provider === "aws" ? (
              <label className="field">
                Region
                <input aria-label="AWS region" placeholder="e.g. eu-west-1" value={region} onChange={(event) => setRegion(event.target.value.trim())} spellCheck={false} />
              </label>
            ) : null}
            <input role="searchbox" aria-label="Find cloud cluster" placeholder="Filter clusters" value={query} onChange={(event) => setQuery(event.target.value)} />
            {provider === "azure" ? (
              <label className="check" title="kubelogin convert-kubeconfig -l azurecli: no device-code prompt on every connect">
                <input type="checkbox" checked={cliLogin} onChange={(event) => setCliLogin(event.target.checked)} />
                Sign in with my az login (kubelogin)
              </label>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="problem" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</p> : null}
        {account && !clusters && !error && (provider !== "aws" || region) ? <GazeInline label="Listing clusters…" /> : null}
        {clusters && clusters.length === 0 ? <p className="muted">No clusters here{provider === "aws" ? ` in ${region}` : ""}.</p> : null}
        {shown.length > 0 ? (
          <ul className="aks-list">
            {shown.map((cluster) => {
              const done = added.some((item) => item.name.endsWith(cluster.name));
              return (
                <li key={`${cluster.group}/${cluster.name}`}>
                  <span className="row-main">
                    <strong>{cluster.name}</strong>
                    <small>{[cluster.group, cluster.location !== cluster.group ? cluster.location : "", cluster.version].filter(Boolean).join(" · ")}</small>
                  </span>
                  {cluster.state && !/^(running|succeeded)$/i.test(cluster.state) ? <span className="status warn">{cluster.state}</span> : null}
                  {cluster.note ? <span className="chip">{cluster.note}</span> : null}
                  <button type="button" className={done ? "icon-btn" : "connect icon-btn"} disabled={adding !== null || done} onClick={() => void add(cluster)}>
                    <Icon name={done ? "check" : "plus"} /> {adding === cluster.name ? "Adding" : done ? "Added" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {added.map((item) => <p key={item.name} className="saved-note">Added {item.name}. {item.message.split("\n").slice(-1)[0]}</p>)}
      </section>
    </div>,
    document.body,
  );
}
