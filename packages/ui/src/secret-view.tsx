import { useEffect, useRef, useState } from "react";
import type { ClusterClient, ContextGuard, SecretChange, SecretReveal } from "@podgaze/contracts";
import { Icon } from "./icons";
import { matchesSearch, usePanelSearch } from "./panel-search";

// UTF-8 aware, so "pässwörd ✓" round-trips the way kubectl stores it.
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(encoded: string): { ok: true; text: string | null; bytes: number } | { ok: false; message: string } {
  const compact = encoded.replace(/\s+/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { ok: false, message: "Not valid base64." };
  const binary = atob(compact);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, text: text.includes("\u0000") ? null : text, bytes: bytes.length };
  } catch {
    return { ok: true, text: null, bytes: bytes.length };
  }
}

type Row = {
  id: string;
  key: string;
  // The key this row had when the secret was read; null for a new key.
  originalKey: string | null;
  originalEncoded: string | null;
  value: string;
  encoding: "text" | "base64";
  removed: boolean;
  shown: boolean;
};

let rowSeq = 0;

function rowsFrom(reveal: SecretReveal): Row[] {
  return reveal.values.map((item) => ({
    id: `r${++rowSeq}`,
    key: item.key,
    originalKey: item.key,
    originalEncoded: item.encoded,
    value: item.binary ? item.encoded : item.value,
    encoding: item.binary ? "base64" : "text",
    removed: false,
    shown: false,
  }));
}

function encodedOf(row: Row): string | null {
  if (row.encoding === "text") return toBase64(row.value);
  const decoded = fromBase64(row.value);
  return decoded.ok ? row.value.replace(/\s+/g, "") : null;
}

function changesOf(rows: Row[]): { set: SecretChange[]; remove: string[]; added: number; changed: number } {
  const set: SecretChange[] = [];
  const remove: string[] = [];
  let added = 0;
  let changed = 0;
  for (const row of rows) {
    if (row.removed) {
      if (row.originalKey) remove.push(row.originalKey);
      continue;
    }
    const renamed = row.originalKey !== null && row.key !== row.originalKey;
    if (renamed) remove.push(row.originalKey!);
    if (row.originalKey === null || renamed || encodedOf(row) !== row.originalEncoded) {
      set.push({ key: row.key, value: row.value, encoding: row.encoding });
      if (row.originalKey === null) added += 1;
      else changed += 1;
    }
  }
  return { set, remove, added, changed };
}

// Decoded secret values, an editor that does the base64 for you, and a scratch encoder for one-off strings.
// Once you decode one Secret, the next ones you open on the same cluster decode too, until you hide the values.
// Never on a Protected or Read-only cluster. Kept in memory only, for this run of the app.
let keepRevealedFor: string | null = null;
// Bumped by Hide: a decode that was still in flight must not bring the values back.
let hideGeneration = 0;

export function SecretValues({ client, cluster = "", namespace, name, guard = { protected: false, readOnly: false } }: { client: ClusterClient; cluster?: string; namespace: string; name: string; guard?: ContextGuard }) {
  const mounted = useRef(true);
  const [reveal, setReveal] = useState<SecretReveal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [rawShown, setRawShown] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [typed, setTyped] = useState("");
  const [armed, setArmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolOpen, setToolOpen] = useState(false);
  // Keys only: matching on values would let a search box confirm what a secret holds.
  const needle = usePanelSearch();

  async function load() {
    const generation = hideGeneration;
    setBusy(true);
    setError(null);
    try {
      const found = await client.readSecret(namespace, name);
      if (generation !== hideGeneration || !mounted.current) return;
      setReveal(found);
      keepRevealedFor = cluster;
    } catch (reason) {
      if (!mounted.current) return;
      setReveal(null);
      setError(reason instanceof Error ? reason.message : "Could not decode the secret");
    } finally {
      setBusy(false);
    }
  }

  // Each Secret gets a fresh panel (the inspector keys it by namespace and name); decode it right away when the
  // previous one was shown decoded.
  useEffect(() => {
    mounted.current = true;
    if (keepRevealedFor === cluster && !guard.protected && !guard.readOnly) void load();
    return () => {
      mounted.current = false;
    };
  }, []);

  function hide() {
    hideGeneration += 1;
    keepRevealedFor = null;
    setBusy(false);
    setReveal(null);
    setRows(null);
    setRawShown([]);
    setArmed(false);
  }

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not copy");
    }
  }

  function update(id: string, patch: Partial<Row>) {
    setRows((current) => current?.map((row) => (row.id === id ? { ...row, ...patch } : row)) ?? null);
    setArmed(false);
  }

  function switchEncoding(row: Row, next: "text" | "base64") {
    if (row.encoding === next) return;
    if (next === "base64") {
      update(row.id, { encoding: "base64", value: toBase64(row.value) });
      return;
    }
    const decoded = fromBase64(row.value);
    if (!decoded.ok) {
      setError(`${row.key || "This value"}: ${decoded.message} Fix it before switching to text.`);
      return;
    }
    if (decoded.text === null) {
      setError(`${row.key || "This value"} is binary (${decoded.bytes} bytes), so it can only be edited as base64.`);
      return;
    }
    setError(null);
    update(row.id, { encoding: "text", value: decoded.text });
  }

  const summary = rows ? changesOf(rows) : null;
  const keys = rows?.filter((row) => !row.removed).map((row) => row.key) ?? [];
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  const badKey = rows?.find((row) => !row.removed && !/^[-._a-zA-Z0-9]+$/.test(row.key));
  const badBase64 = rows?.find((row) => !row.removed && row.encoding === "base64" && !fromBase64(row.value).ok);
  const problem = duplicate ? `The key "${duplicate}" is used twice.` : badKey ? `Key "${badKey.key}" may only use letters, digits, "-", "_", and ".".` : badBase64 ? `The value of "${badBase64.key}" is not valid base64.` : null;
  const pending = summary ? summary.set.length + summary.remove.length : 0;
  const removedCount = rows?.filter((row) => row.removed && row.originalKey !== null).length ?? 0;

  async function save() {
    if (!rows || !reveal?.resourceVersion || !summary) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await client.writeSecret({ namespace, name, resourceVersion: reveal.resourceVersion, set: summary.set, remove: summary.remove });
      setReveal(saved);
      setRows(null);
      setArmed(false);
      setTyped("");
      setNotice("Saved. Pods that read this Secret as environment variables keep the old value until they restart; mounted files update within about a minute.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the secret");
    } finally {
      setBusy(false);
    }
  }

  const editBlocked = guard.readOnly ? "Read-only: Podgaze does not change secrets here." : reveal?.immutable ? "This Secret is immutable." : null;

  return (
    <div className="reveal">
      <div className="forward-form">
        {!rows ? (
          <>
            <button type="button" className="icon-btn" disabled={busy} onClick={() => void load()}>
              <Icon name={reveal ? "refresh" : "eye"} />
              {reveal ? "Reload values" : "Decode values"}
            </button>
            {reveal ? (
              <button type="button" className="ghost icon-btn" onClick={hide} title="Hide the values; the next Secrets you open stay hidden too">
                <Icon name="x" /> Hide values
              </button>
            ) : null}
          </>
        ) : null}
        {reveal && !rows ? (
          <button
            type="button"
            className="icon-btn"
            disabled={busy || Boolean(editBlocked)}
            title={editBlocked ?? "Change values; Podgaze encodes them to base64"}
            onClick={() => {
              setRows(rowsFrom(reveal));
              setNotice(null);
              setError(null);
            }}
          >
            <Icon name="sliders" /> Edit
          </button>
        ) : null}
        <button type="button" className="icon-btn ghost" aria-expanded={toolOpen} onClick={() => setToolOpen((value) => !value)}>
          <Icon name="command" /> Base64 tool
        </button>
        {reveal ? <span className="muted">{reveal.type}</span> : <span className="muted">Shows the stored secret values as text.</span>}
      </div>
      {toolOpen ? <Base64Tool /> : null}
      {reveal?.managedBy ? (
        <p className="warn-note">Managed by {reveal.managedBy}. A change made here is likely to be overwritten the next time it syncs; change the source instead.</p>
      ) : null}
      {editBlocked && reveal ? <p className="muted">{editBlocked}</p> : null}
      {error ? <p className="problem" role="alert">{error}</p> : null}
      {notice ? <p className="saved-note" role="status">{notice}</p> : null}
      {reveal && !rows && reveal.values.length === 0 ? <p className="muted">This secret has no data.</p> : null}

      {reveal && !rows ? (
        <ul className="secret-list">
          {reveal.values.filter((item) => matchesSearch(needle, item.key)).map((item) => {
            const raw = rawShown.includes(item.key);
            return (
              <li key={item.key}>
                <div className="secret-key">
                  <strong>{item.key}</strong>
                  <span className="secret-actions">
                    <button type="button" className="icon-btn ghost" aria-pressed={raw} onClick={() => setRawShown((current) => (raw ? current.filter((key) => key !== item.key) : [...current, item.key]))}>
                      {raw ? "Decoded" : "Base64"}
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Copy ${item.key}`} disabled={item.binary && !raw} onClick={() => void copy(item.key, raw ? item.encoded : item.value)}>
                      <Icon name={copied === item.key ? "check" : "copy"} />
                      {copied === item.key ? "Copied" : "Copy"}
                    </button>
                  </span>
                </div>
                {raw ? <pre className="secret-raw">{item.encoded}</pre> : item.binary ? <p className="muted">Binary value ({fromBase64(item.encoded).ok ? (fromBase64(item.encoded) as { bytes: number }).bytes : "?"} bytes). Switch to Base64 to see it.</p> : <pre>{item.value}</pre>}
              </li>
            );
          })}
        </ul>
      ) : null}

      {rows ? (
        <div className="secret-editor" aria-label="Edit secret">
          <p className="muted">Type values as plain text; Podgaze stores them base64-encoded (UTF-8), like <code>kubectl create secret --from-literal</code>. Switch a value to Base64 to paste an already encoded one.</p>
          <ul className="secret-rows">
            {rows.filter((row) => !needle || row.originalKey === null || matchesSearch(needle, row.key)).map((row) => {
              const decoded = row.encoding === "base64" ? fromBase64(row.value) : null;
              const preview = row.encoding === "text" ? toBase64(row.value) : null;
              const changed = !row.removed && (row.originalKey === null || row.key !== row.originalKey || encodedOf(row) !== row.originalEncoded);
              return (
                <li key={row.id} className={row.removed ? "removed" : changed ? "changed" : undefined}>
                  <div className="secret-row-head">
                    <input
                      aria-label="Secret key"
                      className="secret-key-input"
                      value={row.key}
                      placeholder="KEY_NAME"
                      disabled={row.removed}
                      onChange={(event) => update(row.id, { key: event.target.value.trim() })}
                      spellCheck={false}
                    />
                    {row.originalKey === null ? <span className="chip ok-chip">new</span> : changed ? <span className="chip warn-chip">changed</span> : null}
                    {row.removed ? <span className="chip bad-chip">will be removed</span> : null}
                    <span className="head-spacer" />
                    <div className="segmented" role="group" aria-label={`Encoding of ${row.key || "new key"}`}>
                      <button type="button" aria-pressed={row.encoding === "text"} disabled={row.removed} onClick={() => switchEncoding(row, "text")}>Text</button>
                      <button type="button" aria-pressed={row.encoding === "base64"} disabled={row.removed} onClick={() => switchEncoding(row, "base64")}>Base64</button>
                    </div>
                    <button type="button" className="dock-icon ghost" aria-label={row.shown ? `Hide ${row.key}` : `Show ${row.key}`} title={row.shown ? "Hide value" : "Show value"} onClick={() => update(row.id, { shown: !row.shown })}>
                      <Icon name="eye" />
                    </button>
                    <button
                      type="button"
                      className={row.removed ? "icon-btn" : "icon-btn danger"}
                      aria-label={row.removed ? `Keep ${row.key}` : `Remove ${row.key}`}
                      onClick={() => {
                        if (row.originalKey === null) setRows((current) => current?.filter((item) => item.id !== row.id) ?? null);
                        else update(row.id, { removed: !row.removed });
                      }}
                    >
                      {row.removed ? "Undo" : <Icon name="x" />}
                    </button>
                  </div>
                  {row.removed ? null : (
                    <>
                      <textarea
                        aria-label={`Value of ${row.key || "new key"}`}
                        className={row.shown ? "secret-value" : "secret-value masked"}
                        value={row.value}
                        rows={Math.min(8, Math.max(1, row.value.split("\n").length))}
                        onChange={(event) => update(row.id, { value: event.target.value })}
                        spellCheck={false}
                      />
                      <p className="secret-preview mono">
                        {preview !== null ? (
                          <>Stored as <span title={preview}>{preview.length > 72 ? `${preview.slice(0, 72)}…` : preview || "(empty)"}</span></>
                        ) : decoded && decoded.ok ? (
                          decoded.text !== null ? <>Decodes to {row.shown ? <span>{decoded.text.length > 72 ? `${decoded.text.slice(0, 72)}…` : decoded.text}</span> : "•••"}</> : <>Binary, {decoded.bytes} bytes</>
                        ) : (
                          <span className="problem">Not valid base64</span>
                        )}
                      </p>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="link-btn"
            onClick={() => setRows((current) => [...(current ?? []), { id: `r${++rowSeq}`, key: "", originalKey: null, originalEncoded: null, value: "", encoding: "text", removed: false, shown: true }])}
          >
            + Add key
          </button>
          {problem ? <p className="problem" role="alert">{problem}</p> : null}
          <form
            className="secret-save"
            onSubmit={(event) => {
              event.preventDefault();
              if (guard.protected && !armed) {
                setArmed(true);
                return;
              }
              if (!guard.protected || typed === name) void save();
            }}
          >
            <span className="muted">
              {summary && pending > 0
                ? [summary.changed && `${summary.changed} changed`, summary.added && `${summary.added} added`, removedCount && `${removedCount} removed`].filter(Boolean).join(" · ")
                : "No changes yet"}
            </span>
            {armed && guard.protected ? (
              <label className="field">
                Type <strong>{name}</strong> to save on this protected cluster
                <input aria-label="Confirm secret name" value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
              </label>
            ) : null}
            <button type="submit" className="connect icon-btn" disabled={busy || pending === 0 || Boolean(problem) || (armed && guard.protected && typed !== name)}>
              <Icon name="check" /> {busy ? "Saving" : armed ? "Save now" : "Save secret"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => {
                setRows(null);
                setArmed(false);
                setTyped("");
                setError(null);
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

// Encode or decode any string: for values that go into a Secret by hand, or for reading one from elsewhere.
export function Base64Tool() {
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const decoded = mode === "decode" && input.trim() ? fromBase64(input) : null;
  const output = mode === "encode"
    ? (input ? toBase64(input) : "")
    : decoded?.ok ? (decoded.text ?? `(binary, ${decoded.bytes} bytes)`) : "";
  return (
    <section className="b64-tool" aria-label="Base64 tool">
      <div className="b64-head">
        <div className="segmented" role="group" aria-label="Base64 direction">
          <button type="button" aria-pressed={mode === "encode"} onClick={() => setMode("encode")}>Encode</button>
          <button type="button" aria-pressed={mode === "decode"} onClick={() => setMode("decode")}>Decode</button>
        </div>
        <span className="muted">{mode === "encode" ? "Text to base64 (UTF-8)" : "Base64 to text"}. Runs locally; nothing is sent anywhere.</span>
      </div>
      <textarea aria-label={mode === "encode" ? "Text to encode" : "Base64 to decode"} value={input} onChange={(event) => setInput(event.target.value)} rows={3} spellCheck={false} placeholder={mode === "encode" ? "Type or paste text" : "Paste base64"} />
      {decoded && !decoded.ok ? <p className="problem">{decoded.message}</p> : null}
      <div className="b64-out">
        <pre aria-label="Base64 result">{output || " "}</pre>
        <button
          type="button"
          className="icon-btn"
          disabled={!output}
          onClick={() => void navigator.clipboard?.writeText(output).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }, () => undefined)}
        >
          <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}
