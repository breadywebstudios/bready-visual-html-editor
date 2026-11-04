// Bready Visual HTML Editor — VS Code extension entry point.
// The visual editor is a CustomTextEditor: VS Code owns the TextDocument, so
// undo/redo, the dirty marker, Save, git and other editors all stay in sync.
'use strict';
const vscode = require('vscode');

const VIEW_TYPE = 'breadyVisualHtml.editor';
const ASSET_GLOB = '**/*.{css,png,jpg,jpeg,gif,webp,avif,svg,ico,bmp,woff,woff2,ttf,otf,mp4,webm,mp3,php,phtml,inc,html,htm}';

function activate(context) {
  const provider = new VisualHtmlEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }),
    vscode.commands.registerCommand('breadyVisualHtml.open', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage('Open or select an .html file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
    vscode.commands.registerCommand('breadyVisualHtml.openSource', () => provider.showSource())
  );
}

class VisualHtmlEditorProvider {
  constructor(context) {
    this.context = context;
    this.active = null; // the session whose panel is focused
  }

  showSource(range) {
    const s = this.active;
    if (!s) return;
    const doc = s.document;
    const opts = { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false };
    if (range) opts.selection = new vscode.Range(doc.positionAt(range.start), doc.positionAt(range.end));
    vscode.window.showTextDocument(doc, opts);
  }

  async resolveCustomTextEditor(document, panel) {
    const session = new Session(this, document, panel);
    if (panel.active) this.active = session;
    panel.onDidChangeViewState(() => { if (panel.active) this.active = session; });
    panel.onDidDispose(() => { if (this.active === session) this.active = null; session.dispose(); });
  }
}

class Session {
  constructor(provider, document, panel) {
    this.provider = provider;
    this.document = document;
    this.panel = panel;
    this.disposables = [];
    this.suppress = 0;          // >0 while we apply our own edit
    this.queue = Promise.resolve();
    this.saveTimer = null;

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    this.root = folder ? folder.uri : (document.uri.scheme === 'file' ? vscode.Uri.joinPath(document.uri, '..') : null);
    this.relSegs = this.root ? relativeSegs(this.root, document.uri) : [baseName(document.uri)];

    const mediaRoot = vscode.Uri.joinPath(provider.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.html(panel.webview, mediaRoot);

    this.disposables.push(
      panel.webview.onDidReceiveMessage(m => this.onMessage(m)),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() !== document.uri.toString() || this.suppress > 0 || !e.contentChanges.length) return;
        this.post({ type: 'update', text: document.getText() });
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('breadyVisualHtml')) this.post({ type: 'config', ...this.config() });
      })
    );
    if (this.root) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, ASSET_GLOB));
      let t = null;
      // ignore saves of this very file — the editor already has its text
      const changed = (uri) => { if (uri && uri.toString() === document.uri.toString()) return; clearTimeout(t); t = setTimeout(() => this.post({ type: 'assetsChanged' }), 300); };
      watcher.onDidChange(changed); watcher.onDidCreate(changed); watcher.onDidDelete(changed);
      this.disposables.push(watcher);
    }
  }

  config() {
    const c = vscode.workspace.getConfiguration('breadyVisualHtml');
    return { autoSave: c.get('autoSave', true), runScripts: c.get('runScripts', false) };
  }

  post(msg) { this.panel.webview.postMessage(msg); }

  html(webview, mediaRoot) {
    const nonce = makeNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'editor.js'));
    // The page preview is a srcdoc iframe, which inherits this policy. Local
    // assets are handed to it as blob: URLs; page scripts only run when the
    // user turns scripts on, and then only because the editor stamps them
    // with this nonce.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `media-src ${webview.cspSource} https: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https: blob:`,
      `font-src ${webview.cspSource} https: data: blob:`,
      `script-src 'nonce-${nonce}'`,
      'connect-src https:',
      'frame-src blob: data: https:'
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Visual HTML Editor</title>
</head>
<body>
<div id="app" data-nonce="${nonce}"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', text: this.document.getText(), segs: this.relSegs, hasRoot: !!this.root, ...this.config() });
        break;
      case 'edit':
        this.queue = this.queue.then(() => this.applyEdit(m)).catch(err => console.error(err));
        break;
      case 'undo': await vscode.commands.executeCommand('undo'); break;
      case 'redo': await vscode.commands.executeCommand('redo'); break;
      case 'save': await this.queue; await this.document.save(); break;
      case 'reload': await this.queue; await this.reload(); break;
      case 'addToHead':
        try {
          const uri = this.safeUri(m.segs);
          const d = await vscode.workspace.openTextDocument(uri);
          const text = d.getText();
          const at = text.search(/<\/head\s*>/i);
          if (at < 0 || text.includes(m.html)) break;
          const lineStart = text.lastIndexOf('\n', at - 1) + 1;
          const before = text.slice(lineStart, at);
          const edit = new vscode.WorkspaceEdit();
          if (/^[ \t]*$/.test(before)) edit.insert(uri, d.positionAt(lineStart), before + '  ' + m.html + '\n');
          else edit.insert(uri, d.positionAt(at), m.html);
          if (await vscode.workspace.applyEdit(edit) && this.config().autoSave) await d.save();
          this.post({ type: 'assetsChanged' });
        } catch (err) { vscode.window.showWarningMessage('Could not add the font link: ' + err.message); }
        break;
      case 'openFile':
        try {
          const uri = this.safeUri(m.segs);
          if (m.visual) await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
          else await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
        } catch (err) { vscode.window.showWarningMessage('Could not open that file: ' + err.message); }
        break;
      case 'select': this.syncSelection(m.start, m.end); break;
      case 'showSource': this.provider.active = this; this.provider.showSource(m.start != null ? { start: m.start, end: m.end } : undefined); break;
      case 'setConfig':
        await vscode.workspace.getConfiguration('breadyVisualHtml').update(m.key, m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'request':
        try {
          const value = await this.handleRequest(m);
          this.post({ type: 'reply', id: m.id, ok: true, value });
        } catch (err) {
          this.post({ type: 'reply', id: m.id, ok: false, error: String(err && err.message || err) });
        }
        break;
    }
  }

  async applyEdit(m) {
    const doc = this.document;
    const cur = doc.getText();
    if (cur.length !== m.baseLen || cur.slice(m.start, m.end) !== m.old) {
      this.post({ type: 'editDone', ok: false, text: cur });
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end)), m.text);
    let ok = false;
    this.suppress++;
    try { ok = await vscode.workspace.applyEdit(edit); } finally { this.suppress--; }
    this.post({ type: 'editDone', ok, text: ok ? undefined : doc.getText() });
    if (ok && this.config().autoSave) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => { this.queue.then(() => doc.isDirty && doc.save()); }, 400);
    }
  }

  // Go back to what's saved on disk: discards unsaved visual/text edits (they stay
  // in VS Code's undo history) and refreshes CSS/images in the preview.
  async reload() {
    const doc = this.document;
    if (doc.isDirty) {
      const pick = await vscode.window.showWarningMessage(
        `Discard unsaved changes to ${baseName(doc.uri)} and reload the last saved version?`,
        { modal: true }, 'Discard & Reload');
      if (pick !== 'Discard & Reload') return;
    }
    let disk = null;
    try { disk = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(doc.uri)); } catch { /* unsaved new file */ }
    if (disk != null && disk !== doc.getText()) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), disk);
      this.suppress++;
      try { await vscode.workspace.applyEdit(edit); } finally { this.suppress--; }
      await doc.save();
    }
    this.post({ type: 'reloaded', text: doc.getText() });
  }

  syncSelection(start, end) {
    const doc = this.document;
    for (const ed of vscode.window.visibleTextEditors) {
      if (ed.document.uri.toString() !== doc.uri.toString()) continue;
      const r = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
      ed.selection = new vscode.Selection(r.start, r.end);
      ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  safeUri(segs) {
    if (!this.root || !Array.isArray(segs) || !segs.length) throw new Error('No folder');
    for (const s of segs) {
      if (typeof s !== 'string' || !s || s === '.' || s === '..' || /[\\/\0]/.test(s)) throw new Error('Invalid path');
    }
    return vscode.Uri.joinPath(this.root, ...segs);
  }

  async handleRequest(m) {
    if (m.kind === 'readFile') {
      // Sent as base64: VS Code may JSON-serialise webview messages, which turns
      // a Uint8Array into a plain object and corrupts CSS/images.
      const bytes = await vscode.workspace.fs.readFile(this.safeUri(m.segs));
      return { base64: Buffer.from(bytes).toString('base64') };
    }
    if (m.kind === 'pickImage') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use this image',
        filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico'] }
      });
      if (!picked || !picked[0]) return null;
      const srcUri = picked[0];
      const dirSegs = m.dirSegs || [];
      const dir = dirSegs.length ? this.safeUri(dirSegs) : this.root;
      if (!dir) throw new Error('Open the website folder in VS Code to add images.');
      // already inside the target folder? just reference it
      if (srcUri.toString().startsWith(dir.toString() + '/') && !srcUri.path.slice(dir.path.length + 1).includes('/')) {
        return { name: baseName(srcUri) };
      }
      await vscode.workspace.fs.createDirectory(dir);
      const safe = baseName(srcUri).replace(/[^\w.\-]+/g, '-').toLowerCase();
      const dot = safe.lastIndexOf('.');
      const stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
      const bytes = await vscode.workspace.fs.readFile(srcUri);
      let name = safe;
      for (let k = 1; ; k++) {
        const dest = vscode.Uri.joinPath(dir, name);
        let existing = null;
        try { existing = await vscode.workspace.fs.stat(dest); } catch { /* free */ }
        if (!existing) { await vscode.workspace.fs.writeFile(dest, bytes); break; }
        if (existing.size === bytes.length) break; // same file already there
        name = `${stem}-${k}${ext}`;
      }
      return { name };
    }
    throw new Error('Unknown request');
  }

  dispose() {
    clearTimeout(this.saveTimer);
    for (const d of this.disposables) d.dispose();
  }
}

function relativeSegs(root, uri) {
  const rp = root.path.replace(/\/$/, '');
  const p = uri.path;
  if (p.startsWith(rp + '/')) return p.slice(rp.length + 1).split('/');
  return [baseName(uri)];
}
function baseName(uri) { return uri.path.split('/').pop(); }
function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function deactivate() {}
module.exports = { activate, deactivate };
