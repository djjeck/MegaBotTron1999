/**
 * A script's code in Monaco (docs/bot-os.md D78), bundled into the image by Vite, never loaded
 * from a CDN: TypeScript with the node's `.d.ts` as its one library beside ES2022 (no DOM, no
 * Node), so that the script API completes, its help shows on hover, and syntax and type errors
 * are marked as typed; each change's diagnostics are told to the editor, which refuses to keep
 * code that does not parse. Loaded lazily, in its own chunk, when a script is opened. Left out of
 * the unit tests' coverage (Monaco needs a browser's layout and workers); seen in the browser.
 */
import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import type { ScriptTarget } from 'monaco-editor/languages/features/typescript/register';
import {
  getTypeScriptWorker,
  ModuleKind,
  typescriptDefaults,
} from 'monaco-editor/languages/features/typescript/register';
import TsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { useEffect, useRef } from 'react';
import 'monaco-editor/languages/definitions/typescript/register';

/** What the editor's TypeScript says of the code: its syntax errors, and its type errors. */
export interface CodeDiagnostics {
  syntax: string[];
  types: string[];
}

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) =>
    label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker(),
};

typescriptDefaults.setCompilerOptions({
  // ES2022 (TypeScript's 9), which Monaco's own enum stops short of.
  target: 9 as ScriptTarget,
  module: ModuleKind.ESNext,
  lib: ['es2022'],
  strict: true,
  noEmit: true,
  allowNonTsExtensions: true,
  // A module, so that the script may await at its top level, its globals the .d.ts's.
  moduleDetection: 3,
});
typescriptDefaults.setEagerModelSync(true);

const dark = (): boolean => window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

const where = (
  d: { start?: number | undefined; messageText: unknown },
  model: monaco.editor.ITextModel
): string => {
  const at = d.start === undefined ? undefined : model.getPositionAt(d.start);
  const text =
    typeof d.messageText === 'string'
      ? d.messageText
      : String((d.messageText as { messageText?: unknown }).messageText ?? '');
  return at === undefined ? text : `line ${at.lineNumber}: ${text}`;
};

export default function ScriptCode(props: {
  id: string;
  value: string;
  dts: string;
  onChange: (code: string) => void;
  onDiagnostics: (d: CodeDiagnostics) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const changed = useRef(props.onChange);
  const told = useRef(props.onDiagnostics);
  changed.current = props.onChange;
  told.current = props.onDiagnostics;

  useEffect(() => {
    const lib = typescriptDefaults.addExtraLib(props.dts, 'file:///script-api.d.ts');
    return () => lib.dispose();
  }, [props.dts]);

  useEffect(() => {
    if (host.current === null) return;
    const uri = monaco.Uri.parse(`file:///${props.id}.ts`);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(props.value, 'typescript', uri);
    const editor = monaco.editor.create(host.current, {
      model,
      theme: dark() ? 'vs-dark' : 'vs',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      tabSize: 2,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      ariaLabel: `the script of ${props.id}`,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const diagnose = (): void => {
      void (async () => {
        const client = await (await getTypeScriptWorker())(uri);
        const [syntax, types] = await Promise.all([
          client.getSyntacticDiagnostics(uri.toString()),
          client.getSemanticDiagnostics(uri.toString()),
        ]);
        if (live)
          told.current({
            syntax: syntax.map((d) => where(d, model)),
            types: types.map((d) => where(d, model)),
          });
      })();
    };
    const sub = model.onDidChangeContent(() => {
      changed.current(model.getValue());
      clearTimeout(timer);
      timer = setTimeout(diagnose, 300);
    });
    diagnose();
    editor.focus();
    return () => {
      live = false;
      clearTimeout(timer);
      sub.dispose();
      editor.dispose();
      model.dispose();
    };
    // The model is made once per node opened; its value is the editor's from then on.
  }, [props.id]);

  return <div ref={host} className="script-code" />;
}
