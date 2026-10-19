import { Worker } from "node:worker_threads";
import type { LogMatch } from "@podgaze/contracts";

export const MAX_MATCHES = 2000;
export const MAX_PODS = 60;
// Kubelet serves the newest lines first with tailLines; more than this per container is not searched.
export const LINES_PER_CONTAINER = 20_000;


export type Matcher = (line: string) => [number, number][] | null;

// A plain search is literal; a regex search is the user's own pattern, checked before it runs.
export function compileMatcher(pattern: string, regex: boolean, caseSensitive: boolean): Matcher {
  if (!pattern) throw new Error("Type something to search for.");
  if (pattern.length > 500) throw new Error("The pattern is too long.");
  let expression: RegExp;
  try {
    expression = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new Error(`Not a valid regular expression: ${error instanceof Error ? error.message : pattern}`);
  }
  return (line) => {
    const ranges: [number, number][] = [];
    expression.lastIndex = 0;
    for (let found = expression.exec(line); found; found = expression.exec(line)) {
      if (found[0].length === 0) {
        expression.lastIndex += 1;
        continue;
      }
      ranges.push([found.index, found.index + found[0].length]);
      if (ranges.length >= 20) break;
    }
    return ranges.length > 0 ? ranges : null;
  };
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

// Lines of one container's log (read with timestamps), keeping only those that match.
export function searchText(text: string, matcher: Matcher, pod: string, container: string, cap = MAX_MATCHES): { matches: LogMatch[]; lines: number; dropped: number } {
  let matches: LogMatch[] = [];
  let lines = 0;
  let dropped = 0;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    lines += 1;
    const stamp = STAMP.exec(raw);
    const line = stamp ? raw.slice(stamp[0].length) : raw;
    const ranges = matcher(line);
    if (ranges) {
      matches.push({ pod, container, time: stamp ? stamp[1]! : "", line: line.length > 4000 ? `${line.slice(0, 4000)}…` : line, ranges: ranges.filter(([start]) => start < 4000) });
      // Lines arrive oldest first: keep only the newest cap, so a match-everything search stays small.
      if (matches.length > cap * 2) {
        dropped += matches.length - cap;
        matches = matches.slice(-cap);
      }
    }
  }
  if (matches.length > cap) {
    dropped += matches.length - cap;
    matches = matches.slice(-cap);
  }
  return { matches, lines, dropped };
}

// Oldest first, as logs read; when there are too many, the newest are the ones kept.
export function mergeMatches(groups: LogMatch[][]): { matches: LogMatch[]; truncated: boolean } {
  // Kubelet timestamps drop trailing zeros in the fraction, so compare them as times, not as text.
  const at = (match: LogMatch) => Date.parse(match.time) || 0;
  const all = groups.flat().sort((left, right) => at(left) - at(right));
  return all.length > MAX_MATCHES ? { matches: all.slice(-MAX_MATCHES), truncated: true } : { matches: all, truncated: false };
}

export async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) results.push(...(await Promise.all(items.slice(index, index + size).map(run))));
  return results;
}

// A user's regex can take exponential time on one unlucky line ((\w|\d)+$, (.|\s)*x, (a+)+). It runs in a worker
// thread with a time limit, so a bad pattern is stopped and reported instead of freezing the app's main process.
// The matching code mirrors searchText above; the tests check both give the same result.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const expression = new RegExp(workerData.pattern, workerData.flags);
const STAMP = /^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z) /;
function ranges(line) {
  const found = [];
  expression.lastIndex = 0;
  for (let hit = expression.exec(line); hit; hit = expression.exec(line)) {
    if (hit[0].length === 0) { expression.lastIndex += 1; continue; }
    found.push([hit.index, hit.index + hit[0].length]);
    if (found.length >= 20) break;
  }
  return found.length ? found : null;
}
parentPort.on("message", ({ id, text, pod, container, cap }) => {
  let matches = [];
  let lines = 0;
  let dropped = 0;
  for (const raw of text.split("\\n")) {
    if (!raw) continue;
    lines += 1;
    const stamp = STAMP.exec(raw);
    const line = stamp ? raw.slice(stamp[0].length) : raw;
    const hits = ranges(line);
    if (!hits) continue;
    matches.push({ pod, container, time: stamp ? stamp[1] : "", line: line.length > 4000 ? line.slice(0, 4000) + "\u2026" : line, ranges: hits.filter(([start]) => start < 4000) });
    if (matches.length > cap * 2) { dropped += matches.length - cap; matches = matches.slice(-cap); }
  }
  if (matches.length > cap) { dropped += matches.length - cap; matches = matches.slice(-cap); }
  parentPort.postMessage({ id, result: { matches, lines, dropped } });
});
`;

export function createRegexSearch(pattern: string, caseSensitive: boolean, timeoutMs = 5000) {
  compileMatcher(pattern, true, caseSensitive); // syntax errors are reported here, before any worker starts
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags: caseSensitive ? "g" : "gi" } });
  worker.unref();
  let nextId = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let failed: Error | null = null;
  const waiting = new Map<number, { resolve: (value: ReturnType<typeof searchText>) => void; reject: (error: Error) => void }>();
  worker.on("message", (message: { id: number; result: ReturnType<typeof searchText> }) => {
    waiting.get(message.id)?.resolve(message.result);
    waiting.delete(message.id);
  });
  worker.on("error", (error) => {
    failed = error;
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
  });

  // One text at a time, so the time limit measures matching, not waiting in line.
  function search(text: string, pod: string, container: string, cap = MAX_MATCHES): Promise<ReturnType<typeof searchText>> {
    const run = () => new Promise<ReturnType<typeof searchText>>((resolve, reject) => {
      if (failed) return reject(failed);
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        failed = new Error(`The pattern took longer than ${timeoutMs / 1000}s on ${pod}/${container} and was stopped. Patterns like (a|b)+ or (.|\\s)* can take exponential time; try a simpler one, such as [ab]+ or [\\s\\S]*.`);
        void worker.terminate();
        reject(failed);
      }, timeoutMs);
      waiting.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      worker.postMessage({ id, text, pod, container, cap });
    });
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    return result;
  }

  return { search, close: () => void worker.terminate() };
}
