import { useEffect, useMemo, useRef, useState } from "react";
import type { ClusterClient, ResourceRef, Timeline, TimelineCategory } from "@podgaze/contracts";
import { formatAge } from "./format";
import { GazeInline } from "./loader";
import { matchesSearch, usePanelSearch } from "./panel-search";

const categories: { id: TimelineCategory; label: string }[] = [
  { id: "deploy", label: "Rollouts" },
  { id: "sync", label: "Argo syncs" },
  { id: "scale", label: "Scaling" },
  { id: "crash", label: "Crashes" },
  { id: "oom", label: "OOM kills" },
  { id: "warning", label: "Warnings" },
  { id: "info", label: "Other" },
];

export const timelineKinds = ["Deployment", "StatefulSet", "DaemonSet", "Pod"];

function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// What happened to this app, on one axis: answers "what changed right before it broke?"
export function TimelineView({ client, target, epoch }: { client: ClusterClient; target: ResourceRef; epoch: number }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<TimelineCategory>>(() => new Set(["info"]));
  const [focus, setFocus] = useState<number | null>(null);
  const needle = usePanelSearch();

  const targetKey = `${target.kind}/${target.namespace ?? ""}/${target.name}`;
  const lastFetch = useRef(0);

  // A different object: never show the previous one's history while this one loads.
  useEffect(() => {
    setTimeline(null);
    setFocus(null);
    setError(null);
    lastFetch.current = 0;
  }, [targetKey]);

  // Watch updates (epoch) arrive many times a minute during a rollout. Keep what is shown and refresh it at most
  // every 15 seconds, instead of blanking it and starting the whole query again on each update.
  useEffect(() => {
    let gone = false;
    const wait = Math.max(0, lastFetch.current + 15_000 - Date.now());
    const timer = window.setTimeout(() => {
      lastFetch.current = Date.now();
      client.getTimeline(target).then(
        (found) => {
          if (!gone) {
            setTimeline(found);
            setError(null);
          }
        },
        (reason: unknown) => {
          if (!gone) setError(reason instanceof Error ? reason.message : "Could not build the timeline");
        },
      );
    }, lastFetch.current === 0 ? 0 : wait);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [client, targetKey, epoch]);

  const counts = useMemo(() => {
    const all = new Map<TimelineCategory, number>();
    for (const entry of timeline?.entries ?? []) all.set(entry.category, (all.get(entry.category) ?? 0) + 1);
    return all;
  }, [timeline]);
  const shown = (timeline?.entries ?? []).filter((entry) => !off.has(entry.category) && matchesSearch(needle, entry.title, entry.detail, entry.object));

  // The strip above the list: every entry as a tick, oldest left, now right.
  const span = useMemo(() => {
    if (shown.length === 0) return null;
    const times = shown.map((entry) => Date.parse(entry.time));
    const start = Math.min(...times);
    const end = Math.max(Date.now(), ...times);
    return { start, end: end === start ? start + 1 : end };
  }, [shown]);

  return (
    <section className="timeline" aria-label="Timeline">
      <div className="timeline-filters" role="group" aria-label="Show on the timeline">
        {categories.filter((item) => counts.has(item.id)).map((item) => (
          <button
            key={item.id}
            type="button"
            className={`chip-btn tl-${item.id}`}
            aria-pressed={!off.has(item.id)}
            onClick={() => setOff((current) => {
              const next = new Set(current);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            })}
          >
            <span className="tl-dot" /> {item.label} <span className="muted">{counts.get(item.id)}</span>
          </button>
        ))}
      </div>
      {error ? <p className="problem">{error}</p> : null}
      {!timeline && !error ? <GazeInline label="Reading rollouts, events, and syncs…" /> : null}
      {timeline && timeline.entries.length === 0 ? <p className="muted">Nothing recorded for this object yet.</p> : null}
      {span ? (
        <div className="timeline-strip" aria-hidden="true">
          {shown.map((entry, index) => (
            <button
              key={`${entry.time}-${index}`}
              type="button"
              tabIndex={-1}
              className={`tl-${entry.category}`}
              style={{ left: `${((Date.parse(entry.time) - span.start) / (span.end - span.start)) * 100}%` }}
              title={`${clock(entry.time)} ${entry.title}`}
              onClick={() => {
                setFocus(index);
                document.getElementById(`tl-${index}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
              }}
            />
          ))}
          <span className="timeline-edge">{formatAge(new Date(span.start).toISOString())} ago</span>
          <span className="timeline-edge right">now</span>
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ol className="timeline-list">
          {shown.map((entry, index) => (
            <li key={`${entry.time}-${index}`} id={`tl-${index}`} className={`tl-${entry.category}${focus === index ? " focus" : ""}`}>
              {index === 0 || dayOf(shown[index - 1]!.time) !== dayOf(entry.time) ? <p className="timeline-day">{dayOf(entry.time)}</p> : null}
              <div className="timeline-row">
                <span className="tl-dot" />
                <time dateTime={entry.time} title={new Date(entry.time).toLocaleString()}>{clock(entry.time)}</time>
                <div className="timeline-body">
                  <strong>{entry.title}</strong>
                  {entry.detail ? <span className="timeline-detail">{entry.detail}</span> : null}
                  <small className="muted">{entry.object} · {formatAge(entry.time)} ago</small>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {timeline?.eventsSince ? (
        <p className="muted timeline-note">Kubernetes keeps events only for a while: warnings and scaling go back to {new Date(timeline.eventsSince).toLocaleString()}. Rollouts and Argo syncs go back further.</p>
      ) : null}
    </section>
  );
}
