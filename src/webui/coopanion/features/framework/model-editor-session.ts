import type { PageContext } from '../../base/page.ts';
import { modelEditor } from './model-editor.ts';

type EditorSession = {
  editor: ReturnType<typeof modelEditor>;
  dialogs: HTMLElement;
  preview?: (kind: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>> | undefined;
};

const sessions = new WeakMap<Document, EditorSession>();

/** Coo unmounts every panel on a tab change. The window owns the one model draft. */
export function attachModelEditor(ctx: PageContext, preview?: EditorSession['preview']): EditorSession['editor'] {
  const doc = ctx.root.ownerDocument;
  let session = sessions.get(doc);
  if (!session) {
    const lifetime = new AbortController();
    const dialogs = doc.createElement('div');
    const add = (cleanup: () => void) => lifetime.signal.addEventListener('abort', cleanup, { once: true });
    const editor = modelEditor({
      root: dialogs,
      ui: ctx.ui,
      signal: lifetime.signal,
      lifecycle: {
        add,
        interval(fn, ms) {
          const timer = setInterval(fn, ms);
          const dispose = () => clearInterval(timer);
          add(dispose);
          return { dispose };
        },
      },
    }, { externalNavigation: true, preview: (kind,input) => sessions.get(doc)?.preview?.(kind,input) });
    session = { editor, dialogs };
    sessions.set(doc, session);

    doc.defaultView?.addEventListener('beforeunload', event => {
      if (editor.dirty()) event.preventDefault();
    }, { signal: lifetime.signal });
    doc.defaultView?.addEventListener('pagehide', event => {
      if (event.persisted) return;
      lifetime.abort();
      sessions.delete(doc);
    }, { signal: lifetime.signal });
  }
  session.preview = preview;
  const { editor, dialogs } = session;
  ctx.root.append(dialogs);
  ctx.signal.addEventListener('abort', () => {
    if (dialogs.parentElement !== ctx.root) return;
    editor.deactivate();
    if (session.preview === preview) session.preview = undefined;
    editor.cancelDiscard();
    editor.element.remove();
    dialogs.remove();
  }, { once: true });
  return editor;
}
