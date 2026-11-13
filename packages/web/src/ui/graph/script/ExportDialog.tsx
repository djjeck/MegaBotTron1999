/**
 * A script node's export (docs/bot-os.md D79): its plugin file and its `module.json`, shown and
 * downloaded, to be copied into a module's repository (`src/plugins/<id>.ts` beside its
 * `module.json`), then installed as any module, its node's plugin then the export's.
 */
import { useEffect } from 'react';
import type { ScriptExport } from './export.ts';

/** Saves a text as a file, through the browser's download. */
export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function File(props: { title: string; name: string; text: string }) {
  return (
    <section aria-label={props.name}>
      <h3>
        {props.title} <code>{props.name}</code>
      </h3>
      <p>
        <button type="button" className="primary" onClick={() => download(props.name, props.text)}>
          Download {props.name}
        </button>{' '}
        <button type="button" onClick={() => void navigator.clipboard?.writeText(props.text)}>
          Copy
        </button>
      </p>
      <pre className="export-text">{props.text}</pre>
    </section>
  );
}

export function ExportDialog(props: { id: string; exported: ScriptExport; close: () => void }) {
  const { close, exported } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [close]);
  return (
    <div className="overlay script-overlay">
      <div
        className="card script-export"
        role="dialog"
        aria-modal="true"
        aria-label={`export of ${props.id}`}
      >
        <header>
          <h2>
            Export <code>{props.id}</code> as a plugin
          </h2>
          <button type="button" onClick={close}>
            Close
          </button>
        </header>
        <p className="muted small">
          A module’s plugin of the same id, its manifest made from the node’s ports, its code the
          script’s as typed. Put the file in a module’s <code>src/plugins/</code>, beside its{' '}
          <code>module.json</code> (rename <code>provides</code>), install the module, and give the
          node the plugin <code>{props.id}</code> in place of <code>script</code>: its ports keep
          their names, so its edges stay. As a plugin it runs in the shell’s process, with no worker
          and no limits.
        </p>
        <div className="export-files">
          <File title="The plugin" name={exported.fileName} text={exported.plugin} />
          <File title="Its module" name="module.json" text={exported.moduleJson} />
        </div>
      </div>
    </div>
  );
}
