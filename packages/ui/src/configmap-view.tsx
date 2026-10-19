import { useEffect, useState } from "react";
import { parse } from "yaml";
import type { ClusterClient, ResourceRef } from "@podgaze/contracts";
import { Icon } from "./icons";
import { Highlighted, matchesSearch, usePanelSearch } from "./panel-search";

const LONG = 600;

type Entry = { key: string; value: string; binary: boolean };

export function configMapEntries(text: string): Entry[] {
  const manifest = parse(text) as { data?: Record<string, string>; binaryData?: Record<string, string> } | null;
  return [
    ...Object.entries(manifest?.data ?? {}).map(([key, value]) => ({ key, value: String(value), binary: false })),
    ...Object.keys(manifest?.binaryData ?? {}).map((key) => ({ key, value: "", binary: true })),
  ].sort((left, right) => left.key.localeCompare(right.key));
}

// Reads ConfigMap keys as text, so checking a setting does not mean scrolling YAML.
export function ConfigMapValues({ client, target, epoch }: { client: ClusterClient; target: ResourceRef; epoch: number }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const needle = usePanelSearch();

  useEffect(() => {
    let gone = false;
    setError(null);
    client.getYaml(target).then(
      (text) => {
        if (!gone) setEntries(configMapEntries(text));
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not read the config map");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, target.kind, target.name, target.namespace, epoch]);

  async function copy(entry: Entry) {
    try {
      await navigator.clipboard.writeText(entry.value);
      setCopied(entry.key);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not copy");
    }
  }

  return (
    <section className="reveal" aria-label="Config values">
      <h3>Values</h3>
      {error ? <p className="problem">{error}</p> : null}
      {entries && entries.length === 0 ? <p className="muted">This config map has no data.</p> : null}
      {entries && needle && !entries.some((entry) => matchesSearch(needle, entry.key, entry.value)) ? <p className="muted">No key or value matches.</p> : null}
      {entries ? (
        <ul className="secret-list">
          {entries.filter((entry) => matchesSearch(needle, entry.key, entry.value)).map((entry) => {
            const long = entry.value.length > LONG;
            const expanded = open.includes(entry.key);
            return (
              <li key={entry.key}>
                <div className="secret-key">
                  <strong>{entry.key}</strong>
                  {entry.binary ? null : (
                    <button type="button" className="icon-btn" aria-label={`Copy ${entry.key}`} onClick={() => void copy(entry)}>
                      <Icon name="copy" />
                      {copied === entry.key ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
                {entry.binary ? <p className="muted">Binary value</p> : <pre>{long && !expanded ? `${entry.value.slice(0, LONG)}…` : entry.value}</pre>}
                {long ? (
                  <button type="button" className="link-btn" onClick={() => setOpen((current) => expanded ? current.filter((key) => key !== entry.key) : [...current, entry.key])}>
                    {expanded ? "Show less" : `Show all ${entry.value.length} characters`}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
