import { useEffect, useState } from "react";
import { catalog, customKinds, type AccessRule, type ClusterClient, type WhoCanSubject } from "@podgaze/contracts";
import { GazeInline } from "./loader";

const verbs = ["get", "list", "watch", "create", "update", "patch", "delete"];

function resourceChoices(): { value: string; label: string; group: string }[] {
  const group = (apiVersion: string) => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");
  const items = [...catalog, ...customKinds()].map((entry) => ({ value: entry.plural, label: `${entry.plural}${entry.apiGroup ? `.${entry.apiGroup}` : ""}`, group: group(entry.apiVersion) }));
  const extras = [
    { value: "pods/exec", label: "pods/exec (shell, verb create)", group: "" },
    { value: "pods/log", label: "pods/log", group: "" },
    { value: "pods/portforward", label: "pods/portforward", group: "" },
  ];
  const seen = new Set<string>();
  return [...items, ...extras].filter((item) => {
    const key = `${item.group}/${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Two questions about RBAC: who may do something here, and what may I do.
export function AccessView({ client, namespace }: { client: ClusterClient; namespace: string | null }) {
  const choices = resourceChoices();
  const [verb, setVerb] = useState("delete");
  const [resource, setResource] = useState("/pods");
  const [scope, setScope] = useState<string>(namespace ?? "");
  const [subjects, setSubjects] = useState<WhoCanSubject[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<AccessRule[] | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);

  useEffect(() => {
    setScope(namespace ?? "");
  }, [namespace]);

  useEffect(() => {
    let gone = false;
    setRules(null);
    setRulesError(null);
    client.myRules(namespace).then(
      (found) => {
        if (!gone) setRules(found);
      },
      (reason: unknown) => {
        if (!gone) setRulesError(reason instanceof Error ? reason.message : "Could not read your permissions");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, namespace]);

  async function ask() {
    const [group, plural] = resource.split(/\/(.*)/s) as [string, string];
    setBusy(true);
    setError(null);
    try {
      setSubjects(await client.whoCan({ verb, resource: plural, group, namespace: scope || null }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read RBAC");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="access-view">
      <section className="cmd-card" aria-label="Who can">
        <header>
          <h4>Who can…</h4>
          <p>Reads RoleBindings and ClusterRoleBindings. Webhook or cloud-IAM access that bypasses RBAC is not shown.</p>
        </header>
        <form
          className="access-form"
          onSubmit={(event) => {
            event.preventDefault();
            void ask();
          }}
        >
          <select aria-label="Verb" value={verb} onChange={(event) => setVerb(event.target.value)}>
            {verbs.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select aria-label="Resource" value={resource} onChange={(event) => setResource(event.target.value)}>
            {choices.map((item) => <option key={`${item.group}/${item.value}`} value={`${item.group}/${item.value}`}>{item.label}</option>)}
          </select>
          <span className="muted">in</span>
          <input aria-label="Namespace to check" placeholder="all namespaces" value={scope} onChange={(event) => setScope(event.target.value.trim())} />
          <button type="submit" className="connect" disabled={busy}>{busy ? "Checking" : "Check"}</button>
        </form>
        {error ? <p className="problem" role="alert">{error}</p> : null}
        {subjects ? (
          subjects.length === 0 ? <p className="muted">No RBAC binding grants this.</p> : (
            <table className="access-table">
              <thead><tr><th>Subject</th><th>Through</th><th>Role</th><th>Scope</th></tr></thead>
              <tbody>
                {subjects.map((item) => (
                  <tr key={`${item.kind}/${item.namespace ?? ""}/${item.name}/${item.binding}`}>
                    <td><span className="chip">{item.kind}</span> <span className="mono">{item.namespace ? `${item.namespace}/` : ""}{item.name}</span></td>
                    <td className="mono">{item.binding}</td>
                    <td className="mono">{item.role}</td>
                    <td>{item.scope === "cluster" ? "Whole cluster" : "This namespace"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </section>
      <section className="cmd-card" aria-label="My permissions">
        <header>
          <h4>What I can do in {namespace ?? "default"}</h4>
          <p>From a SelfSubjectRulesReview. It covers RBAC; the API server may still allow more through other authorizers.</p>
        </header>
        {!rules && !rulesError ? <GazeInline label="Asking the API server…" /> : null}
        {rulesError ? <p className="problem">{rulesError}</p> : null}
        {rules ? (
          <table className="access-table">
            <thead><tr><th>Verbs</th><th>Resources</th><th>API groups</th><th>Names</th></tr></thead>
            <tbody>
              {rules.map((rule, index) => (
                <tr key={index}>
                  <td className="mono">{rule.verbs.join(", ")}</td>
                  <td className="mono">{rule.resources.join(", ") || "—"}</td>
                  <td className="mono">{rule.apiGroups.map((group) => group || "core").join(", ") || "—"}</td>
                  <td className="mono">{rule.resourceNames.join(", ") || "any"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </div>
  );
}
