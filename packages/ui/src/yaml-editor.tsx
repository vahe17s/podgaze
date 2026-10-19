import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export { valuesIssue, yamlIssue, type YamlIssue } from "./yaml-check";
import { type YamlIssue, valuesIssue, yamlIssue } from "./yaml-check";

const appearance = new Compartment();

function yamlAppearance(light: boolean) {
  const highlight = HighlightStyle.define(light ? [
    { tag: tags.propertyName, color: "#0969da" },
    { tag: tags.string, color: "#0a3069" },
    { tag: tags.number, color: "#8250df" },
    { tag: tags.bool, color: "#cf222e" },
    { tag: tags.null, color: "#cf222e" },
    { tag: tags.keyword, color: "#cf222e" },
    { tag: tags.comment, color: "#656d76", fontStyle: "italic" },
    { tag: tags.meta, color: "#9a6700" },
    { tag: tags.punctuation, color: "#656d76" },
    { tag: tags.operator, color: "#cf222e" },
  ] : [
    { tag: tags.propertyName, color: "#79c0ff" },
    { tag: tags.string, color: "#a5d6ff" },
    { tag: tags.number, color: "#d2a8ff" },
    { tag: tags.bool, color: "#ff7b72" },
    { tag: tags.null, color: "#ff7b72" },
    { tag: tags.keyword, color: "#ff7b72" },
    { tag: tags.comment, color: "#8b949e", fontStyle: "italic" },
    { tag: tags.meta, color: "#d29922" },
    { tag: tags.punctuation, color: "#8b949e" },
    { tag: tags.operator, color: "#ff7b72" },
  ]);
  const theme = EditorView.theme(light ? {
    "&": { height: "100%", backgroundColor: "#ffffff", color: "#1f2328", fontSize: "var(--editor-font, 12.5px)" },
    "&.cm-focused": { outline: "1px solid #0969da" },
    ".cm-scroller": { overflow: "auto", fontFamily: "\"JetBrains Mono\", ui-monospace, monospace" },
    ".cm-content": { padding: "10px 0", caretColor: "#0969da" },
    ".cm-line": { padding: "0 12px" },
    ".cm-gutters": { backgroundColor: "#f6f8fa", color: "#656d76", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(9, 105, 218, 0.06)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#1f2328" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #cf222e" },
  } : {
    "&": { height: "100%", backgroundColor: "#010409", color: "#e6edf3", fontSize: "var(--editor-font, 12.5px)" },
    "&.cm-focused": { outline: "1px solid #2f81f7" },
    ".cm-scroller": { overflow: "auto", fontFamily: "\"JetBrains Mono\", ui-monospace, monospace" },
    ".cm-content": { padding: "10px 0", caretColor: "#2f81f7" },
    ".cm-line": { padding: "0 12px" },
    ".cm-gutters": { backgroundColor: "#0d1117", color: "#6e7681", border: "none" },
    ".cm-activeLine": { backgroundColor: "rgba(47, 129, 247, 0.08)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#e6edf3" },
    ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy #f85149" },
  }, { dark: !light });
  return [syntaxHighlighting(highlight), theme];
}

function diagnostics(text: string, length: number, mode: "manifest" | "values" = "manifest"): Diagnostic[] {
  const issue = mode === "values" ? valuesIssue(text) : yamlIssue(text);
  if (!issue || issue.to <= issue.from) return [];
  const from = Math.max(0, Math.min(issue.from, length));
  const to = Math.max(from + (length > from ? 0 : 0), Math.min(issue.to, length));
  return [{
    from,
    to: to > from ? to : Math.min(length, from + 1),
    severity: "error",
    message: issue.message,
  }];
}

export function YamlEditor({ value, onChange, mode = "manifest", label = "Manifest" }: { value: string; onChange: (text: string) => void; mode?: "manifest" | "values"; label?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const viewRef = useRef<EditorView | null>(null);
  onChangeRef.current = onChange;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          bracketMatching(),
          yaml(),
          lintGutter(),
          linter((editor) => diagnostics(editor.state.doc.toString(), editor.state.doc.length, mode)),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          appearance.of(yamlAppearance(document.documentElement.dataset.theme === "light")),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const fromUser = update.transactions.some((transaction) =>
              transaction.isUserEvent("input")
              || transaction.isUserEvent("delete")
              || transaction.isUserEvent("paste")
              || transaction.isUserEvent("cut")
              || transaction.isUserEvent("move")
              || transaction.isUserEvent("undo")
              || transaction.isUserEvent("redo"));
            if (fromUser) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    const watchTheme = new MutationObserver(() => {
      view.dispatch({ effects: appearance.reconfigure(yamlAppearance(document.documentElement.dataset.theme === "light")) });
    });
    watchTheme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      watchTheme.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div className="yaml-code" ref={hostRef} />;
}
