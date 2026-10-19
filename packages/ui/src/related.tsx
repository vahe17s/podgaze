import { useEffect, useState } from "react";
import type { ClusterClient, ObjectEvent, RelatedRef, ResourceRef } from "@podgaze/contracts";
import { formatAge, statusTone } from "./format";
import { Icon } from "./icons";
import { GazeInline } from "./loader";
import { matchesSearch, usePanelSearch } from "./panel-search";

const SHOWN = 6;

function groupByRelation(items: RelatedRef[]): [string, RelatedRef[]][] {
  const groups = new Map<string, RelatedRef[]>();
  for (const item of items) groups.set(item.relation, [...(groups.get(item.relation) ?? []), item]);
  return [...groups.entries()];
}

// Owners, pods, services, config, and storage around the selected object, one click away.
export function RelatedObjects({
  client,
  target,
  onNavigate,
}: {
  client: ClusterClient;
  target: ResourceRef;
  onNavigate: (ref: ResourceRef) => void;
}) {
  const [items, setItems] = useState<RelatedRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const needle = usePanelSearch();

  useEffect(() => {
    let gone = false;
    setItems(null);
    setError(null);
    setExpanded([]);
    client.listRelated(target).then(
      (found) => {
        if (!gone) setItems(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not load related objects");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, target.kind, target.name, target.namespace, reload]);

  return (
    <section className="related" aria-label="Related">
      <div className="section-head">
        <h3>Related</h3>
        <button type="button" className="icon-btn" aria-label="Reload related" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" /></button>
      </div>
      {error ? <p className="problem">{error}</p> : null}
      {!items && !error ? <GazeInline label="Looking for owners, pods, services, and config…" /> : null}
      {items && items.length === 0 ? <p className="muted">Nothing points to or from this object.</p> : null}
      {items && items.length > 0 && needle && !items.some((item) => matchesSearch(needle, item.kind, item.name, item.relation, item.status)) ? <p className="muted">No related object matches.</p> : null}
      {items ? groupByRelation(items.filter((item) => matchesSearch(needle, item.kind, item.name, item.relation, item.status))).map(([relation, group]) => {
        // While searching, every match shows; the "show more" fold is for browsing.
        const open = expanded.includes(relation) || Boolean(needle);
        const shown = open ? group : group.slice(0, SHOWN);
        return (
          <div key={relation} className="related-group">
            <p className="eyebrow">{relation}</p>
            <ul>
              {shown.map((item) => (
                <li key={`${item.kind}/${item.namespace ?? ""}/${item.name}`}>
                  <button
                    type="button"
                    className="related-link"
                    aria-label={`Open ${item.kind} ${item.name}`}
                    onClick={() => onNavigate({ kind: item.kind, namespace: item.namespace, name: item.name })}
                  >
                    <span className="related-kind">{item.kind}</span>
                    <span className="related-name">{item.name}</span>
                    {item.status ? <span className={`status ${statusTone(item.status)}`}>{item.status}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
            {group.length > SHOWN && !needle ? (
              <button type="button" className="link-btn" onClick={() => setExpanded((current) => open ? current.filter((value) => value !== relation) : [...current, relation])}>
                {open ? "Show fewer" : `Show ${group.length - SHOWN} more`}
              </button>
            ) : null}
          </div>
        );
      }) : null}
    </section>
  );
}

// The object's own events, newest first, refreshed while it is open.
export function RecentEvents({ client, target, epoch }: { client: ClusterClient; target: ResourceRef; epoch: number }) {
  const [events, setEvents] = useState<ObjectEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) setTick((value) => value + 1); }, 15_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setEvents(null);
    setError(null);
  }, [target.kind, target.name, target.namespace]);

  useEffect(() => {
    let gone = false;
    client.listEvents(target).then(
      (found) => {
        if (!gone) setEvents(found);
      },
      (reason: unknown) => {
        if (!gone) setError(reason instanceof Error ? reason.message : "Could not load events");
      },
    );
    return () => {
      gone = true;
    };
  }, [client, target.kind, target.name, target.namespace, epoch, tick]);

  const needle = usePanelSearch();
  const warnings = events?.filter((event) => event.type === "Warning").length ?? 0;
  const shownEvents = events?.filter((event) => matchesSearch(needle, event.reason, event.message, event.type, event.source)) ?? null;
  return (
    <section className="events" aria-label="Recent events">
      <h3>Events {warnings > 0 ? <span className="status bad">{warnings} warning{warnings === 1 ? "" : "s"}</span> : null}</h3>
      {error ? <p className="problem">{error}</p> : null}
      {!events && !error ? <GazeInline label="Reading events…" /> : null}
      {events && events.length === 0 ? <p className="muted">No recent events.</p> : null}
      {events && events.length > 0 && shownEvents && shownEvents.length === 0 ? <p className="muted">No event matches.</p> : null}
      {shownEvents && shownEvents.length > 0 ? (
        <ul className="event-list">
          {shownEvents.slice(0, needle ? 50 : 8).map((event, index) => (
            <li key={`${event.time}-${event.reason}-${index}`} className={event.type === "Warning" ? "warning" : undefined}>
              <span className="event-when">{formatAge(event.time) || "—"}</span>
              <strong>{event.reason}</strong>
              {event.count > 1 ? <span className="muted">×{event.count}</span> : null}
              <span className="event-message">{event.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
