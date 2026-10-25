import type { Entry, RunResult } from './model.ts';

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
export const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
function entry(e?: Entry): string {
  return !e ? 'absent' : e.type === 'file' ? `file · SHA-256 ${e.hash}` : 'directory';
}

/** Standalone, script-free report. All adapter-controlled text is escaped. */
export function renderReport(result: RunResult): string {
  const h = escapeHtml;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>WatchConverge · ${h(result.status)} · ${h(result.scenario.name)}</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#f6f6f4;color:#181818}body{max-width:1100px;margin:40px auto;padding:0 24px;line-height:1.65}h1{font-size:42px;letter-spacing:-.04em}h2{font-size:24px}section{border:1px dashed #888;padding:24px;margin:24px 0}code,pre,.mono{font-family:ui-monospace,monospace;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:12px 0;overflow-wrap:anywhere}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pair>div{min-width:0;overflow-wrap:anywhere}summary{cursor:pointer}small{font-size:12px}@media(prefers-color-scheme:dark){:root{background:#101010;color:#eee}}@media(max-width:650px){.pair{grid-template-columns:1fr}}
</style></head><body><p class="mono">WATCHCONVERGE / v0.1 / LOCAL VERIFICATION</p><h1>${h(result.status.toUpperCase())} · ${h(result.scenario.name)}</h1><p>${h(result.message)}</p><p class="mono">${h(result.platform)} · Node ${h(result.node)} · ${h(result.startedAt)}<br>Run ${h(result.id)} · cleanup ${result.cleaned ? 'complete' : 'incomplete'}</p>
<section><h2>Scope & interpretation</h2><pre>${h(JSON.stringify(result.projection ?? 'Readiness not established', null, 2))}</pre><p>Only relative paths, selected object types and SHA-256 content are checked. Metadata, permissions, inode identity and notification order are not verified. Exclusions are literal, case-sensitive path/subtree prefixes applied equally to disk and index. Symlinks and special files are not traversed or checked. A checkpoint match is a sampled observation, not a proof of continuous convergence. Timeout alone does not prove event loss.</p><p>Observation window ${result.options.windowMs} ms · snapshot deadline ${result.options.requestTimeoutMs} ms · readiness deadline ${result.options.readyTimeoutMs} ms · poll ${result.options.pollMs} ms. Timings and notifications vary across operating systems.</p></section>
${result.checkpoints.map((c) => `<section><p class="mono">${h(c.status.toUpperCase())} / ${c.samples} samples / ${c.observedMs} ms / revision ${c.revision} / processing ${c.processing}</p><h2>${h(c.name)}</h2>${c.differences.length ? `<ul>${c.differences.map((d) => `<li><strong>${h(d.kind)} · ${h(d.path)}</strong><div class="pair"><div>DISK<br><code>${h(entry(d.disk))}</code></div><div>INDEX<br><code>${h(entry(d.index))}</code></div></div></li>`).join('')}</ul>` : '<p>No differences in the selected projection.</p>'}<div class="pair"><div><h3>Disk</h3><pre>${h(JSON.stringify(c.disk, null, 2))}</pre></div><div><h3>Consumer index</h3><pre>${h(JSON.stringify(c.index, null, 2))}</pre></div></div>${c.skipped.length ? `<p>Outside file model: ${h(c.skipped.join(', '))}</p>` : ''}</section>`).join('')}
<section><h2>Operations & observations</h2><ol>${result.observations.map((o) => `<li><small class="mono">+${o.ms} ms / ${h(o.kind)}</small><br>${h(o.message)}${o.data === undefined ? '' : `<details><summary>Observation data</summary><pre>${h(JSON.stringify(o.data, null, 2))}</pre></details>`}</li>`).join('')}</ol></section>
<section><details><summary>Replayable scenario JSON</summary><pre>${h(JSON.stringify(result.scenario, null, 2))}</pre></details><details><summary>Complete result JSON</summary><pre>${h(JSON.stringify(result, null, 2))}</pre></details></section></body></html>`;
}
