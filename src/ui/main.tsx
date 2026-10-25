import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Checkpoint, Entry, Observation, RunResult, Scenario } from '../core/model.ts';
import { parseScenario } from '../core/scenarios.ts';
import './style.css';

type Catalog = {
  scenarios: Scenario[];
  adapters: { id: string; name: string; description: string }[];
  platform: string;
};
type State = { id: number; phase: string; observations: Observation[]; result?: RunResult };
type Theme = 'system' | 'light' | 'dark';
const pretty = (s: string) => s.replaceAll('-', ' ');
async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    ...(data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-WatchConverge': '1' },
          body: JSON.stringify(data),
        }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}
function initialTheme(): Theme {
  try {
    const value = localStorage.getItem('wc-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [catalog, setCatalog] = useState<Catalog>();
  const [scenarioId, setScenarioId] = useState('atomic-save');
  const [imported, setImported] = useState<Scenario>();
  const [adapter, setAdapter] = useState('fixed');
  const [command, setCommand] = useState('["node", "/absolute/path/to/adapter.mjs"]');
  const [windowMs, setWindowMs] = useState(1200);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checkpointIndex, setCheckpointIndex] = useState(-1);
  const [filter, setFilter] = useState('all');
  const running = submitting || state?.phase === 'running';
  const scenario = imported ?? catalog?.scenarios.find((s) => s.id === scenarioId);
  const result = state?.result;
  const checkpoints = result?.checkpoints ?? [];
  const checkpoint = checkpoints[checkpointIndex < 0 ? checkpoints.length - 1 : checkpointIndex];
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('wc-theme', theme);
    } catch {
      /* Theme still works without storage. */
    }
  }, [theme]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Catalog>('/api/catalog', undefined, controller.signal)
      .then(setCatalog)
      .catch((e) => {
        if (!controller.signal.aborted) setError(String(e));
      });
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<State | null>('/api/run', undefined, controller.signal);
        setState(next);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(`Connection interrupted: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 250);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (state?.phase !== 'running') setStopping(false);
  }, [state?.phase]);
  async function start(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scenario || running) return;
    setError('');
    setSubmitting(true);
    setCheckpointIndex(-1);
    try {
      const argv: unknown = adapter === 'custom' ? JSON.parse(command) : undefined;
      const response = await api<{ id: number }>('/api/run', {
        scenario: imported ?? scenarioId,
        adapter,
        command: argv,
        windowMs,
      });
      setState({ id: response.id, phase: 'running', observations: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }
  async function stop() {
    setStopping(true);
    try {
      await api('/api/stop', {});
    } catch (e) {
      setError(String(e));
      setStopping(false);
    }
  }
  async function importScenario(file?: File) {
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('Scenario exceeds 1 MiB');
      const value = parseScenario(JSON.parse(await file.text()));
      setImported(value);
      setError('');
    } catch (e) {
      setError(`Import failed: ${String(e)}`);
    }
  }
  const observations = state?.observations ?? [];
  const filtered = observations.filter((o) => filter === 'all' || o.kind === filter);
  const visible = filtered.slice(-250);
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="WatchConverge home">
          <img src="/icon.svg" alt="" width="36" height="36" />
          <span>
            WatchConverge<span className="version">v0.1</span>
          </span>
        </a>
        <div className="header-tools">
          <span className="local-label">
            <span className="node" /> LOCAL ONLY
          </span>
          <label className="theme-control">
            <span className="sr-only">Theme</span>
            <select
              aria-label="Theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
            >
              <option value="system">System theme</option>
              <option value="light">Light theme</option>
              <option value="dark">Dark theme</option>
            </select>
          </label>
        </div>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">FILESYSTEM / CONSUMER / GROUND TRUTH</p>
            <h1>
              Does your index
              <br />
              <span>match the disk?</span>
            </h1>
            <p className="intro-copy">
              Verify a consumer’s cached view after filesystem changes.
              <br className="wide-only" /> Real writes. Real watchers. Independently verified.
            </p>
          </div>
          <div className="schematic" aria-hidden="true">
            <div className="schema-label">
              DISK <span>INDEX</span>
            </div>
            <svg viewBox="0 0 260 138" fill="none">
              <title>File tree and index comparison</title>
              <g stroke="currentColor" strokeWidth="1">
                <path d="M20 18v103m0-88h55m-55 39h55m-55 39h55M75 23h24v20H75zm0 39h24v20H75zm0 39h24v20H75z" />
                <path d="M173 33h65m-65 78h65" />
                <path d="M111 33h50m-50 78h50" strokeDasharray="3 5" />
              </g>
              <path d="M132 12v116" stroke="#7089ba" strokeDasharray="2 5" />
              <g stroke="#7089ba" strokeWidth="2">
                <path d="m185 64 16 16m0-16-16 16" />
                <path d="M111 72h50" strokeDasharray="3 5" />
              </g>
              <circle cx="20" cy="18" r="3" fill="#7089ba" />
            </svg>
            <p>One path. Two views.</p>
          </div>
        </section>
        {error && (
          <div className="error-banner" role="alert">
            <strong>Request failed</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        <section className="configuration" aria-labelledby="configure-title">
          <div className="section-heading">
            <h2 id="configure-title">
              <span className="section-number">01</span> Configure a run
            </h2>
            <span className="micro">OWNED TEMPORARY TREE</span>
          </div>
          <form onSubmit={(e) => void start(e)}>
            <div className="config-fields">
              <label>
                Scenario
                <select
                  value={imported ? 'imported' : scenarioId}
                  disabled={running || !catalog}
                  onChange={(e) => {
                    setImported(undefined);
                    setScenarioId(e.target.value);
                  }}
                >
                  {catalog?.scenarios.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  {imported && <option value="imported">Imported · {imported.name}</option>}
                </select>
              </label>
              <label>
                Consumer adapter
                <select
                  value={adapter}
                  disabled={running || !catalog}
                  onChange={(e) => setAdapter(e.target.value)}
                >
                  {catalog?.adapters.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.id === 'broken' &&
                      catalog.platform !== 'darwin' &&
                      catalog.platform !== 'linux'
                        ? ' (unsupported here)'
                        : ''}
                    </option>
                  ))}
                  <option value="custom">Custom JSONL adapter…</option>
                </select>
              </label>
              <label className="window-field">
                Observation window{' '}
                <span className="input-unit">
                  <input
                    aria-label="Observation window in milliseconds"
                    type="number"
                    required
                    min="100"
                    max="10000"
                    step="100"
                    value={windowMs}
                    disabled={running}
                    onChange={(e) => setWindowMs(Number(e.target.value))}
                  />
                  <span>ms</span>
                </span>
              </label>
            </div>
            {adapter === 'custom' && (
              <div className="custom-adapter">
                <label>
                  Adapter command · JSON argv
                  <textarea
                    required
                    rows={2}
                    spellCheck={false}
                    value={command}
                    disabled={running}
                    onChange={(e) => setCommand(e.target.value)}
                    aria-describedby="custom-help"
                  />
                </label>
                <p id="custom-help">
                  Runs trusted local code with your permissions. Use an absolute script path. stdout
                  is protocol JSONL; stderr is for logs. Snapshot requests must read the existing
                  index without scanning.
                </p>
              </div>
            )}
            <div className="config-description">
              <p>{scenario?.description ?? 'Connecting to the local runner…'}</p>
              <ol className="scenario-sequence" aria-label="Scenario checkpoints">
                {scenario?.steps.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Scenario steps are immutable and never reordered in this preview.
                  <li key={i}>
                    <b>{String(i + 1).padStart(2, '0')}</b>
                    {step.name}
                  </li>
                ))}
              </ol>
            </div>
            <div className="run-actions">
              <div>
                <button className="run-button" type="submit" disabled={running || !catalog}>
                  {running ? 'Run in progress' : 'Run scenario'}
                  <span aria-hidden="true">↗</span>
                </button>
                {running && (
                  <button type="button" onClick={() => void stop()} disabled={stopping}>
                    {stopping ? 'Stopping…' : 'Stop run'}
                  </button>
                )}
                <label className={`import-button ${running ? 'disabled' : ''}`}>
                  Import scenario
                  <input
                    aria-label="Import scenario"
                    type="file"
                    accept=".json,application/json"
                    disabled={running}
                    onChange={(e) => {
                      void importScenario(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
              <p>
                New tree on every run.
                <br />
                Removed after completion or stop.
              </p>
            </div>
          </form>
        </section>
        <section className="verification" aria-labelledby="verify-title">
          <div className="section-heading">
            <h2 id="verify-title">
              <span className="section-number">02</span> Verify convergence
            </h2>
            <span className="status-chip" role="status">
              {running
                ? stopping
                  ? 'STOPPING'
                  : 'OBSERVING'
                : result
                  ? result.status.toUpperCase()
                  : 'AWAITING RUN'}
            </span>
          </div>
          <div className="verdict">
            <div>
              <h3>
                {running
                  ? 'Watching the consumer catch up…'
                  : result
                    ? result.status === 'pass'
                      ? 'The checked states match.'
                      : result.status === 'diverged'
                        ? 'Disk and index differ.'
                        : result.status === 'stopped'
                          ? 'Run stopped.'
                          : result.status === 'unsupported'
                            ? 'Unsupported on this platform.'
                            : 'Convergence is unconfirmed.'
                    : 'Ready to compare disk and index.'}
              </h3>
              <p>
                {running
                  ? (observations.at(-1)?.message ??
                    'Starting the adapter and waiting for readiness.')
                  : (result?.message ??
                    'Run a scenario to compare an independent disk snapshot with the consumer’s existing index. Event order and event counts do not decide the result.')}
              </p>
            </div>
            {result && (
              <p className="run-meta">
                {result.scenario.name}
                <br />
                {result.platform}
                <br />
                Node {result.node}
                <br />
                {result.cleaned ? 'Tree cleaned up' : 'Cleanup incomplete'}
              </p>
            )}
          </div>
          {checkpoints.length > 0 && (
            <nav className="checkpoint-tabs" aria-label="Checkpoints">
              {checkpoints.map((c, i) => (
                <button
                  type="button"
                  key={c.id}
                  className={checkpoint === c ? 'selected' : ''}
                  aria-pressed={checkpoint === c}
                  onClick={() => setCheckpointIndex(i)}
                >
                  <span className="node" />
                  {c.name}
                  <span className="micro">{c.status.toUpperCase()}</span>
                </button>
              ))}
            </nav>
          )}
          <Comparison checkpoint={checkpoint} />
          <div className="scope-note">
            <span className="node" />
            <p>
              {result?.projection
                ? `Projection: ${result.projection.types.join(' + ')} · relative POSIX paths · SHA-256. Excluded prefixes: ${result.projection.excludes.join(', ') || 'none'}.`
                : 'Default projection: files + directories · relative paths · SHA-256 content.'}
              <br />
              Metadata is outside this check. Symlinks are not followed. PASS applies only to the
              selected projection, scenario and checked checkpoints.
            </p>
          </div>
        </section>
        <section className="timeline-section" aria-labelledby="timeline-title">
          <div className="section-heading">
            <h2 id="timeline-title">
              <span className="section-number">03</span> Operations & observations
            </h2>
            <label>
              <span className="sr-only">Timeline filter</span>
              <select
                aria-label="Timeline filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All observations</option>
                <option value="operation">Operations</option>
                <option value="event">Watcher notifications</option>
                <option value="processed">Processing completed</option>
                <option value="comparison">Comparisons</option>
                <option value="snapshot">Consumer snapshots</option>
                <option value="diagnostic">Diagnostics & logs</option>
              </select>
            </label>
          </div>
          {visible.length ? (
            <>
              <p className="timeline-caption micro">
                {filtered.length > 250
                  ? `LAST 250 OF ${filtered.length} OBSERVATIONS · FULL TIMELINE IN EXPORT`
                  : `${filtered.length} OBSERVATIONS`}{' '}
                · TIMINGS ARE LOCAL TO THIS RUN
              </p>
              <ol className="timeline">
                {visible.map((o) => (
                  <li key={o.seq}>
                    <span className="timeline-time">+{o.ms.toLocaleString()} ms</span>
                    <span className={`event-kind kind-${o.kind}`}>
                      {o.kind === 'event' ? 'notification' : o.kind}
                    </span>
                    <div>
                      <p>{o.message}</p>
                      {o.data !== undefined && (
                        <details>
                          <summary>Inspect data</summary>
                          <pre>{JSON.stringify(o.data, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <div className="empty-timeline">
              <span className="timeline-line" />
              <p>
                {observations.length
                  ? 'No observations match this filter.'
                  : 'Your run will leave a trace here.'}
                <small>Writes, notifications, processing and comparisons appear separately.</small>
              </p>
            </div>
          )}
        </section>
        <section className="export-section" aria-labelledby="export-title">
          <div>
            <p className="eyebrow">KEEP THE EVIDENCE</p>
            <h2 id="export-title">Export the evidence.</h2>
            <p>
              A replayable scenario, the full result, or a self-contained report.
              <br />
              The HTML report opens offline with no external assets.
            </p>
          </div>
          <div className="export-links">
            {['scenario.json', 'result.json', 'report.html'].map((file, i) =>
              result ? (
                <a
                  key={file}
                  href={`/api/export/${file}?runId=${encodeURIComponent(result.id)}`}
                  download
                >
                  <span className="micro">0{i + 1}</span>
                  {['Scenario JSON', 'Result JSON', 'HTML report'][i]}
                  <span aria-hidden="true">↓</span>
                </a>
              ) : (
                <span className="export-disabled" key={file}>
                  <span className="micro">0{i + 1}</span>
                  {['Scenario JSON', 'Result JSON', 'HTML report'][i]}
                  <span aria-hidden="true">↓</span>
                </span>
              ),
            )}
          </div>
        </section>
        <footer>
          <span>WatchConverge / v0.1</span>
          <span>Local files. Bounded observations. Explicit scope.</span>
        </footer>
      </main>
    </>
  );
}
function EntryView({ entry }: { entry?: Entry }) {
  return entry ? (
    <>
      <span className="entry-type">{entry.type}</span>
      {entry.type === 'file' && <code title={entry.hash}>{entry.hash}</code>}
    </>
  ) : (
    <span className="absent">absent</span>
  );
}
function Comparison({ checkpoint }: { checkpoint?: Checkpoint }) {
  const paths = checkpoint
    ? [
        ...new Set([...checkpoint.disk.map((e) => e.path), ...checkpoint.index.map((e) => e.path)]),
      ].sort()
    : [];
  return (
    <div className="comparison">
      <div className="comparison-header">
        <span>PATH / COMPARISON</span>
        <span>
          DISK <small>independent walk</small>
        </span>
        <span>
          INDEX <small>consumer cache</small>
        </span>
      </div>
      {checkpoint ? (
        <>
          <div className="comparison-stats micro">
            {checkpoint.differences.length} DIFFERENCES · {checkpoint.samples} SAMPLES ·{' '}
            {checkpoint.observedMs} MS · REVISION {checkpoint.revision} ·{' '}
            {checkpoint.processing ? 'PROCESSING PENDING' : 'CONSUMER IDLE'}
          </div>
          {paths.length ? (
            paths.map((path) => {
              const d = checkpoint.disk.find((e) => e.path === path),
                i = checkpoint.index.find((e) => e.path === path),
                diff = checkpoint.differences.find((e) => e.path === path);
              return (
                <div className={`comparison-row ${diff ? 'different' : ''}`} key={path}>
                  <div>
                    <code>{path}</code>
                    <span className="difference-label">{diff ? pretty(diff.kind) : 'match'}</span>
                  </div>
                  <div data-testid={`disk-${path}`}>
                    <span className="sr-only">Disk {path}</span>
                    <EntryView entry={d} />
                  </div>
                  <div data-testid={`index-${path}`}>
                    <span className="sr-only">Index {path}</span>
                    <EntryView entry={i} />
                  </div>
                </div>
              );
            })
          ) : (
            <p className="empty-index">Both projections are empty at this checkpoint.</p>
          )}
          {checkpoint.skipped.length > 0 && (
            <p className="scope-note">Outside the file model: {checkpoint.skipped.join(', ')}</p>
          )}
        </>
      ) : (
        <div className="empty-comparison">
          <span className="brackets" aria-hidden="true">
            [ &nbsp; ≍ &nbsp; ]
          </span>
          <h4>No snapshots yet</h4>
          <p>Disk and index will be compared here, path by path.</p>
        </div>
      )}
    </div>
  );
}
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing application root element');
createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
