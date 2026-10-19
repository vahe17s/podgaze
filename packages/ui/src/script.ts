import type { AuditEntry } from "@podgaze/contracts";

function shellQuote(value: string): string {
  return /^[\w.@:/=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

// Text from the cluster or a manifest can contain line breaks; in a script they would end the comment and turn
// the rest of the line into a command. Everything that is not the command itself goes through this.
function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// Commands that cannot run again as they are: they read a manifest from stdin, a values file Podgaze deleted, or
// need a terminal.
export function replayProblem(command: string): string | null {
  if (/[\r\n]/.test(command)) return "contains a line break";
  if (/\s-f\s+-(\s|$)/.test(command)) return "applied a manifest from the editor";
  if (/^helm\s/.test(command) && /\s-f\s+values\.yaml\b/.test(command)) return "used a values file that no longer exists";
  if (/\s-(it|ti)\b|\s--stdin\b|^kubectl\s+(\S+\s+)*(edit|exec|debug|attach)\b/.test(command)) return "is interactive";
  return null;
}

// Pins each command to the context it ran against, so the script does the same thing wherever it is run.
export function withContext(command: string, context: string): string {
  if (/^kubectl\s/.test(command) && !/\s--context[=\s]/.test(command)) return command.replace(/^kubectl\s/, `kubectl --context ${shellQuote(context)} `);
  if (/^helm\s/.test(command) && !/\s--kube-context[=\s]/.test(command)) return `${command} --kube-context ${shellQuote(context)}`;
  return command;
}

// Actions done in Podgaze, as a runbook: oldest first, each pinned to its context; failures and dry runs commented out.
export function actionsScript(entries: AuditEntry[], now = new Date()): string {
  const ordered = [...entries].sort((left, right) => left.time.localeCompare(right.time));
  const lines = [
    "#!/usr/bin/env bash",
    `# ${ordered.length} action${ordered.length === 1 ? "" : "s"} exported from Podgaze on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    "# Read it before running: it repeats changes against the contexts named below.",
    "set -euo pipefail",
  ];
  for (const entry of ordered) {
    lines.push("", oneLine(`# ${entry.time.slice(0, 16).replace("T", " ")} · ${entry.action} ${entry.target}${entry.namespace ? ` -n ${entry.namespace}` : ""} · ${entry.cluster}`));
    const command = withContext(entry.kubectl, entry.cluster);
    const problem = replayProblem(command);
    if (entry.dryRun) lines.push(oneLine(`# dry run only, not applied: ${command}`));
    else if (!entry.ok) lines.push(oneLine(`# failed${entry.error ? ` (${entry.error})` : ""}: ${command}`));
    else if (problem) lines.push(oneLine(`# not replayable, it ${problem}: ${command}`));
    else lines.push(command);
  }
  return `${lines.join("\n")}\n`;
}
