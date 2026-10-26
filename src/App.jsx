import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import './App.css';
import {
  saveSnapshot,
  listSnapshots,
  loadSnapshotItems,
  deleteSnapshot,
} from './historyDb.js';

const PROXY_BASE = '/proxy/api/directory/plugins';
const FULL_API_BASE = 'https://api.anthropic.com/api/directory/plugins';

const FIXED_PARAMS = {
  visibility: 'commercial,enterprise,gsuite-google,gsuite-google-editors,public',
  verified_tier: 'anthropic,partner,community',
  limit: '500',
};

const FULL_API_URL = `${FULL_API_BASE}?${new URLSearchParams(FIXED_PARAMS).toString()}`;
const PAGE_SIZE = 20;

const TABS = [
  { id: 'connectors', label: 'Connectors' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'all', label: 'All' },
];

const TAXONOMY_FIELDS = [
  'object_acted_on',
  'work_department',
  'industry',
  'life_area',
  'subject',
];

const PRIMARY_ORDER = [
  'work_department',
  'industry',
  'object_acted_on',
  'life_area',
  'subject',
];

/* Pure helpers */
function classify(item) {
  const types = new Set((item?.components ?? []).map((c) => c?.type).filter(Boolean));
  if (types.has('desktop_extension')) return 'Extension';
  if (types.size === 1 && types.has('mcp_server') && !item?.source?.repository) {
    return 'Connector';
  }
  return 'Plugin';
}

function getRawType(item) {
  const types = Array.from(
    new Set((item?.components ?? []).map((c) => c?.type).filter(Boolean))
  ).sort();
  return types.length ? types.join('+') : 'none';
}

function taxValues(item, field) {
  const val = item?.taxonomy?.[field];
  if (val === null || val === undefined || val === '') return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  return [val];
}

function allTaxValues(item) {
  const all = TAXONOMY_FIELDS.flatMap((f) => taxValues(item, f));
  return Array.from(new Set(all));
}

function primaryTaxonomy(item) {
  for (const field of PRIMARY_ORDER) {
    const vals = taxValues(item, field);
    if (vals.length > 0) return vals[0];
  }
  return null;
}

function humanize(slug) {
  if (!slug) return '';
  const str = String(slug).replaceAll('-', ' ');
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function getEndpoints(item) {
  const endpoints = [];
  for (const comp of item?.components ?? []) {
    if (comp?.type !== 'mcp_server' || !comp.endpoint) continue;
    const ep = comp.endpoint;
    if (ep.url) endpoints.push(ep.url);
    if (Array.isArray(ep.options)) {
      for (const opt of ep.options) {
        if (opt?.url) endpoints.push(opt.url);
      }
    }
    if (Array.isArray(ep.hosts)) {
      for (const host of ep.hosts) {
        if (host) {
          endpoints.push(`user-provided: https://${host}${ep.path_prefix ?? ''}`);
        }
      }
    }
    if (ep.regex) {
      endpoints.push(`user-provided pattern: ${ep.regex}`);
    }
  }
  return Array.from(new Set(endpoints));
}

function shorten(s, n = 42) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtDate(t) {
  if (!t) return '—';
  const s = String(t).trim();
  return s.length >= 10 ? s.slice(0, 10) : s || '—';
}

function fmtDateTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function isHttp(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(params, stopRef) {
  let attempt = 0;
  while (true) {
    if (stopRef.current) return null;
    try {
      const res = await fetch(`${PROXY_BASE}?${params.toString()}`);
      if (res.ok) {
        return await res.json();
      }
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`HTTP ${res.status} — ${res.statusText}`);
      }
    } catch (err) {
      if (err.message && err.message.startsWith('HTTP ')) {
        throw err;
      }
    }
    if (stopRef.current) return null;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
    await sleep(delay);
    attempt++;
  }
}

function escapeCSVCell(val) {
  if (val === null || val === undefined) return '""';
  const s = String(val);
  return `"${s.replaceAll('"', '""')}"`;
}

function buildCSV(items) {
  const headers = [
    'id',
    'name',
    'slug',
    'category',
    'component_types',
    'taxonomy_category',
    'object_acted_on',
    'work_department',
    'industry',
    'life_area',
    'subject',
    'publisher',
    'verified_tier',
    'summary',
    'description',
    'endpoint_url',
    'tools',
    'documentation',
    'added_time',
    'updated_time',
  ];
  const rows = [headers.map(escapeCSVCell).join(',')];
  for (const item of items) {
    const tools = (item?.components ?? [])
      .flatMap((c) => (c?.tools ?? []).map((t) => t?.name))
      .filter(Boolean)
      .join('; ');

    const row = [
      item?.id,
      item?.name,
      item?.slug,
      classify(item),
      getRawType(item),
      primaryTaxonomy(item),
      taxValues(item, 'object_acted_on').join('; '),
      taxValues(item, 'work_department').join('; '),
      taxValues(item, 'industry').join('; '),
      taxValues(item, 'life_area').join('; '),
      taxValues(item, 'subject').join('; '),
      item?.publisher?.name,
      item?.verified_tier,
      item?.summary,
      item?.description,
      getEndpoints(item).join('; '),
      tools,
      item?.links?.documentation,
      item?.added_time,
      item?.updated_time,
    ];
    rows.push(row.map(escapeCSVCell).join(','));
  }
  return rows.join('\n');
}

/* Modals */
function ItemModal({ item, onClose }) {
  const [detail, setDetail] = useState(item);
  const [status, setStatus] = useState('loading');
  const [showRawJson, setShowRawJson] = useState(false);
  const closeBtnRef = useRef(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    const fetchSingleItem = async () => {
      try {
        const escapedId = String(item.id).replaceAll("'", String.raw`\'`);
        const params = new URLSearchParams({
          visibility: FIXED_PARAMS.visibility,
          verified_tier: FIXED_PARAMS.verified_tier,
          limit: '5',
          filter: `id == '${escapedId}'`,
        });
        const res = await fetch(`${PROXY_BASE}?${params.toString()}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const json = await res.json();
          if (json.data && json.data.length > 0) {
            setDetail(json.data[0]);
            setStatus('ok');
          } else {
            setStatus('fallback');
          }
        } else {
          setStatus('fallback');
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          setStatus('fallback');
        }
      }
    };

    fetchSingleItem();
    return () => controller.abort();
  }, [item.id]);

  const handleBackdropMouseDown = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const endpoints = getEndpoints(detail);
  const tools = (detail.components ?? [])
    .flatMap((c) => (c?.tools ?? []).map((t) => t?.name))
    .filter(Boolean);

  const iconUrl = detail.media?.icons?.[0]?.url;
  const hasValidIcon = isHttp(iconUrl);
  const titleText = detail.name || detail.title || 'Untitled';
  const categoryName = classify(detail);

  const groups = TAXONOMY_FIELDS.map((f) => ({
    field: f,
    vals: taxValues(detail, f),
  })).filter((g) => g.vals.length > 0);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-modal-title"
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <div className="modal-header-left">
            {hasValidIcon ? (
              <img
                src={iconUrl}
                alt=""
                className="modal-icon"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="modal-icon-placeholder">
                {titleText.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="modal-title-area">
              <h2 id="item-modal-title" className="modal-title">
                {titleText}
              </h2>
              <div className="modal-subtitle">
                <span className={`cat cat--${categoryName.toLowerCase()}`}>
                  {categoryName}
                </span>
                <span className="chip">{detail.verified_tier || '—'}</span>
                <span>
                  by{' '}
                  {isHttp(detail.publisher?.url) ? (
                    <a
                      href={detail.publisher.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                    >
                      {detail.publisher?.name || 'Unknown'}
                    </a>
                  ) : (
                    detail.publisher?.name || '—'
                  )}
                </span>
              </div>
            </div>
          </div>
          <button
            ref={closeBtnRef}
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="modal-status-bar">
          {status === 'loading' && (
            <>
              <div className="spinner" />
              <span>Fetching latest details…</span>
            </>
          )}
          {status === 'ok' && (
            <span>Loaded fresh from the directory API</span>
          )}
          {status === 'fallback' && (
            <span>Could not reach the API — showing data from the table fetch</span>
          )}
        </div>

        <div className="modal-body">
          {detail.summary && (
            <div className="modal-section">
              <p style={{ fontSize: '0.9rem', lineHeight: '1.5' }}>{detail.summary}</p>
            </div>
          )}

          {detail.description && detail.description !== detail.summary && (
            <div className="modal-section">
              <span className="modal-section-title">Description</span>
              <p
                style={{
                  fontSize: '0.85rem',
                  lineHeight: '1.5',
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-line',
                }}
              >
                {detail.description}
              </p>
            </div>
          )}

          <div className="modal-section">
            <span className="modal-section-title">Details</span>
            <div className="details-grid">
              <div className="detail-item">
                <span className="detail-label">Category</span>
                <span className="detail-val">{categoryName}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Components</span>
                <span className="detail-val mono-cell">{getRawType(detail)}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Publisher</span>
                <span className="detail-val">{detail.publisher?.name || '—'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Tier</span>
                <span className="detail-val">{detail.verified_tier || '—'}</span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Added</span>
                <span className="detail-val">
                  {detail.added_time
                    ? `${fmtDate(detail.added_time)} (${detail.added_time})`
                    : '—'}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Updated</span>
                <span className="detail-val">
                  {detail.updated_time
                    ? `${fmtDate(detail.updated_time)} (${detail.updated_time})`
                    : '—'}
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">Slug</span>
                <span className="detail-val mono-cell">
                  <code>{detail.slug || '—'}</code>
                </span>
              </div>
              <div className="detail-item">
                <span className="detail-label">ID</span>
                <span className="detail-val mono-cell">
                  <code>{detail.id || '—'}</code>
                </span>
              </div>
              {detail.license !== undefined && detail.license !== null && (
                <div className="detail-item">
                  <span className="detail-label">License</span>
                  <span className="detail-val">
                    {typeof detail.license === 'object'
                      ? JSON.stringify(detail.license)
                      : String(detail.license)}
                  </span>
                </div>
              )}
              {detail.installation?.state && (
                <div className="detail-item">
                  <span className="detail-label">Install State</span>
                  <span className="detail-val">{detail.installation.state}</span>
                </div>
              )}
            </div>
          </div>

          <div className="modal-section">
            <span className="modal-section-title">Taxonomy</span>
            {groups.length === 0 ? (
              <span style={{ fontSize: '0.85rem', color: 'var(--text-3)' }}>—</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {groups.map((g) => (
                  <div key={g.field} className="tax-group">
                    <span className="tax-group-label">{humanize(g.field)}:</span>
                    {g.vals.map((v, idx) => (
                      <span key={idx} className="chip">
                        {humanize(v)}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {endpoints.length > 0 && (
            <div className="modal-section">
              <span className="modal-section-title">
                MCP Endpoint{endpoints.length > 1 ? 's' : ''}
              </span>
              {endpoints.map((ep, idx) => (
                <pre
                  key={idx}
                  className="raw-json"
                  style={{ margin: 0, padding: '6px 10px' }}
                >
                  <code>{ep}</code>
                </pre>
              ))}
            </div>
          )}

          {tools.length > 0 && (
            <div className="modal-section">
              <span className="modal-section-title">Tools ({tools.length})</span>
              <div className="chips-row">
                {tools.map((t, idx) => (
                  <span key={idx} className="chip chip--mono">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(detail.compatibility) && detail.compatibility.length > 0 && (
            <div className="modal-section">
              <span className="modal-section-title">Compatibility</span>
              <div className="chips-row">
                {detail.compatibility.map((c, idx) => (
                  <span
                    key={idx}
                    className={`chip ${c?.state === 'works' ? 'chip--compat-works' : ''}`}
                  >
                    {c?.surface}: {c?.state}
                  </span>
                ))}
              </div>
            </div>
          )}

          {Array.isArray(detail.tags) && detail.tags.length > 0 && (
            <div className="modal-section">
              <span className="modal-section-title">Tags</span>
              <div className="chips-row">
                {detail.tags.map((tag, idx) => (
                  <span key={idx} className="chip">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {detail.links &&
            typeof detail.links === 'object' &&
            (() => {
              const validLinks = Object.entries(detail.links).filter(([_, url]) =>
                isHttp(url)
              );
              if (!validLinks.length) return null;
              return (
                <div className="modal-section">
                  <span className="modal-section-title">Links</span>
                  <div className="chips-row">
                    {validLinks.map(([k, url]) => (
                      <a
                        key={k}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-ghost"
                        style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                      >
                        {humanize(k)} ↗
                      </a>
                    ))}
                  </div>
                </div>
              );
            })()}

          <div className="modal-section">
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: 'fit-content' }}
              onClick={() => setShowRawJson(!showRawJson)}
            >
              {showRawJson ? 'Hide raw JSON' : 'Show raw JSON'}
            </button>
            {showRawJson && (
              <pre className="raw-json">{JSON.stringify(detail, null, 2)}</pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryModal({
  history,
  onClose,
  onView,
  onRemove,
  historyBusy,
  historyError,
}) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const closeBtnRef = useRef(null);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  useEffect(() => {
    closeBtnRef.current?.focus();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleBackdropMouseDown = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={handleBackdropMouseDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="history-modal-title"
    >
      <div className="modal-dialog">
        <div className="modal-header">
          <div>
            <h2 id="history-modal-title" className="modal-title">
              History
            </h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-2)', marginTop: '4px' }}>
              Saved fetches are stored in this browser only.
            </p>
          </div>
          <button
            ref={closeBtnRef}
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {historyError && (
            <div className="error-box" style={{ padding: '8px 12px' }}>
              {historyError}
            </div>
          )}

          {history.length === 0 ? (
            <p style={{ textAlign: 'center', color: 'var(--text-3)', padding: '24px 0' }}>
              No saved fetches yet. A complete fetch is saved here automatically.
            </p>
          ) : (
            <div className="history-list">
              {history.map((h) => {
                const isConfirming = confirmDeleteId === h.id;
                const pagesPart = h.pages ? `${h.pages} pages · ` : '';
                const metaText = `${h.count} items · ${pagesPart}${h.connectors ?? 0} connectors · ${h.plugins ?? 0} plugins · ${h.extensions ?? 0} extensions`;

                return (
                  <div key={h.id} className="history-item">
                    <div className="history-item-left">
                      <span className="history-date">{fmtDateTime(h.savedAt)}</span>
                      <span className="history-meta">{metaText}</span>
                    </div>
                    <div className="history-item-actions">
                      <button
                        className="btn btn-primary"
                        style={{ padding: '5px 12px', fontSize: '0.8rem' }}
                        onClick={() => onView(h)}
                        disabled={historyBusy}
                      >
                        {historyBusy ? 'Loading…' : 'View'}
                      </button>

                      {isConfirming ? (
                        <>
                          <button
                            className="btn btn-stop"
                            style={{ padding: '5px 10px', fontSize: '0.8rem' }}
                            onClick={() => {
                              onRemove(h);
                              setConfirmDeleteId(null);
                            }}
                          >
                            Delete
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ padding: '5px 10px', fontSize: '0.8rem' }}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn-ghost"
                          style={{ padding: '5px 10px', fontSize: '0.8rem' }}
                          onClick={() => setConfirmDeleteId(h.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* Main App Component */
export default function App() {
  const [allItems, setAllItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const [activeTab, setActiveTab] = useState('connectors');
  const [rawVisible, setRawVisible] = useState(false);
  const [rawSample, setRawSample] = useState(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [saveMsg, setSaveMsg] = useState(null);
  const [copied, setCopied] = useState(false);

  const stopRef = useRef(false);
  const collectedRef = useRef([]);
  const seenRef = useRef(new Set());
  const rawCaptured = useRef(false);
  const expectedRef = useRef(0);

  const refreshHistory = useCallback(async () => {
    try {
      const list = await listSnapshots();
      setHistory(list);
    } catch {
      setHistoryError('Could not read saved history from this browser.');
    }
  }, []);

  useEffect(() => {
    refreshHistory();
  }, [refreshHistory]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setAllItems([]);
    setRawSample(null);
    setViewing(null);
    setSaveMsg(null);
    setProgress({ pages: 0, items: 0 });
    setPage(1);

    stopRef.current = false;
    collectedRef.current = [];
    seenRef.current = new Set();
    rawCaptured.current = false;
    expectedRef.current = 0;

    let cursor = null;
    let pagesCount = 0;

    try {
      while (true) {
        if (stopRef.current) break;

        const params = new URLSearchParams(FIXED_PARAMS);
        if (cursor) {
          params.set('page', cursor);
        }

        const data = await fetchPage(params, stopRef);
        if (stopRef.current || !data) break;

        pagesCount++;

        if (!rawCaptured.current) {
          rawCaptured.current = true;
          const sample = {
            ...data,
            facets: undefined,
            data: data.data ? data.data.slice(0, 2) : [],
          };
          setRawSample(sample);
          let sum = 0;
          if (Array.isArray(data.facets?.source)) {
            sum = data.facets.source.reduce(
              (acc, s) => acc + (Number(s?.count) || 0),
              0
            );
          }
          expectedRef.current = sum;
        }

        const newItems = [];
        for (const item of data.data ?? []) {
          if (item?.id && !seenRef.current.has(item.id)) {
            seenRef.current.add(item.id);
            newItems.push(item);
          }
        }

        collectedRef.current = collectedRef.current.concat(newItems);
        setAllItems([...collectedRef.current]);
        setProgress({
          pages: pagesCount,
          items: collectedRef.current.length,
          expected: expectedRef.current,
        });

        if (!data.next_page) break;
        cursor = data.next_page;
      }

      if (!stopRef.current && collectedRef.current.length > 0) {
        let cCount = 0;
        let pCount = 0;
        let eCount = 0;
        for (const item of collectedRef.current) {
          const cat = classify(item);
          if (cat === 'Connector') cCount++;
          else if (cat === 'Plugin') pCount++;
          else if (cat === 'Extension') eCount++;
        }

        try {
          await saveSnapshot(
            {
              pages: pagesCount,
              expected: expectedRef.current,
              connectors: cCount,
              plugins: pCount,
              extensions: eCount,
            },
            collectedRef.current
          );
          setSaveMsg('Saved to history.');
          await refreshHistory();
        } catch {
          setSaveMsg(
            'Could not save to history (browser storage unavailable or full).'
          );
        }
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshHistory]);

  const stop = () => {
    stopRef.current = true;
  };

  const resetAll = () => {
    setAllItems([]);
    setProgress(null);
    setError(null);
    setRawSample(null);
    setRawVisible(false);
    setViewing(null);
    setSaveMsg(null);
    setSelected(null);
    setQuery('');
    setPage(1);
    setActiveTab('connectors');
  };

  const viewSnapshot = async (h) => {
    setHistoryBusy(true);
    try {
      const items = await loadSnapshotItems(h.id);
      setAllItems(items);
      setProgress(null);
      setError(null);
      setSaveMsg(null);
      setViewing(h);
      setActiveTab('connectors');
      setQuery('');
      setPage(1);
      setHistoryOpen(false);
    } catch {
      setHistoryError('Could not load that snapshot from this browser.');
    } finally {
      setHistoryBusy(false);
    }
  };

  const removeSnapshot = async (h) => {
    try {
      await deleteSnapshot(h.id);
      if (viewing?.id === h.id) {
        setViewing(null);
      }
      await refreshHistory();
    } catch {
      setHistoryError('Could not delete that snapshot.');
    }
  };

  const copyEndpoint = async () => {
    try {
      await navigator.clipboard.writeText(FULL_API_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy the full URL:', FULL_API_URL);
    }
  };

  const counts = useMemo(() => {
    let connectors = 0;
    let plugins = 0;
    let extensions = 0;
    for (const item of allItems) {
      const cat = classify(item);
      if (cat === 'Connector') connectors++;
      else if (cat === 'Plugin') plugins++;
      else if (cat === 'Extension') extensions++;
    }
    return {
      all: allItems.length,
      connectors,
      plugins,
      extensions,
    };
  }, [allItems]);

  const tabItems = useMemo(() => {
    if (activeTab === 'all') return allItems;
    if (activeTab === 'connectors') {
      return allItems.filter((i) => classify(i) === 'Connector');
    }
    if (activeTab === 'plugins') {
      return allItems.filter((i) => classify(i) === 'Plugin');
    }
    if (activeTab === 'extensions') {
      return allItems.filter((i) => classify(i) === 'Extension');
    }
    return allItems;
  }, [allItems, activeTab]);

  const displayItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabItems;
    return tabItems.filter((item) => {
      const name = (item.name || '').toLowerCase();
      const title = (item.title || '').toLowerCase();
      const pub = (item.publisher?.name || '').toLowerCase();
      const tier = (item.verified_tier || '').toLowerCase();
      const sum = (item.summary || '').toLowerCase();
      const desc = (item.description || '').toLowerCase();
      const rawType = getRawType(item).toLowerCase();
      const tax = allTaxValues(item).join(' ').toLowerCase();
      const ep = getEndpoints(item).join(' ').toLowerCase();

      return (
        name.includes(q) ||
        title.includes(q) ||
        pub.includes(q) ||
        tier.includes(q) ||
        sum.includes(q) ||
        desc.includes(q) ||
        rawType.includes(q) ||
        tax.includes(q) ||
        ep.includes(q)
      );
    });
  }, [tabItems, query]);

  const totalPages = Math.max(1, Math.ceil(displayItems.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = displayItems.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const downloadCSV = () => {
    const csvContent = buildCSV(displayItems);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `claude_${activeTab}_${dateStr}.csv`;
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleTabChange = (tabId) => {
    setActiveTab(tabId);
    setPage(1);
  };

  const handleQueryChange = (e) => {
    setQuery(e.target.value);
    setPage(1);
  };

  const rawSampleText = useMemo(() => {
    if (!rawSample) return '';
    const text = JSON.stringify(rawSample, null, 2);
    if (text.length > 4000) {
      return text.slice(0, 4000) + '\n…(truncated)';
    }
    return text;
  }, [rawSample]);

  const rangeA = displayItems.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const rangeB = Math.min(currentPage * PAGE_SIZE, displayItems.length);

  return (
    <div className="app-root">
      {/* Top Nav */}
      <header className="top-nav">
        <div className="nav-brand">
          <svg
            className="brand-icon"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <rect x="2" y="2" width="9" height="9" rx="2.5" fill="#6366f1" opacity="1" />
            <rect x="13" y="2" width="9" height="9" rx="2.5" fill="#6366f1" opacity="0.55" />
            <rect x="2" y="13" width="9" height="9" rx="2.5" fill="#6366f1" opacity="0.55" />
            <rect x="13" y="13" width="9" height="9" rx="2.5" fill="#6366f1" opacity="0.28" />
          </svg>
          <span>Claude Directory</span>
          <span className="brand-pill">Scraper</span>
        </div>

        <div className="nav-center">
          <div className="nav-divider" />
          <span className="nav-desc">
            Paginates the API until no pages remain, then export to CSV
          </span>
          {loading && (
            <div className="nav-loading">
              <div className="spinner" />
              <span>
                {progress?.items ?? 0}
                {progress?.expected ? ` / ${progress.expected}` : ''} items
              </span>
            </div>
          )}
        </div>

        <div className="nav-actions">
          {!loading && (allItems.length > 0 || error || progress) && (
            <button className="btn btn-ghost" onClick={resetAll}>
              New search
            </button>
          )}

          <button
            className="btn btn-ghost"
            onClick={() => {
              setHistoryError(null);
              setHistoryOpen(true);
              refreshHistory();
            }}
          >
            History
            <span className="btn-count btn-count--muted">{history.length}</span>
          </button>

          {loading ? (
            <button className="btn btn-stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={fetchAll}>
              Fetch All Pages
            </button>
          )}

          {displayItems.length > 0 && (
            <button className="btn btn-export" onClick={downloadCSV}>
              Export CSV
              <span className="btn-count">{displayItems.length}</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="container">
        {/* 1. Endpoint Box */}
        <section className="endpoint-box">
          <div className="endpoint-header">
            <span className="endpoint-label">Endpoint (GET):</span>
            <code className="endpoint-url" title={FULL_API_URL}>
              https://api.anthropic.com/api/directory/plugins?
            </code>
            <button className="btn btn-ghost" onClick={copyEndpoint}>
              {copied ? 'Copied' : 'Copy full URL'}
            </button>
          </div>
          <p className="endpoint-note">
            Next pages append <code>&amp;page=&lt;next_page cursor&gt;</code> until the
            response has no <code>next_page</code>. The browser calls{' '}
            <code>/proxy/api/directory/plugins?…</code>, which the Vite proxy forwards to
            the URL above.
          </p>
        </section>

        {/* 2. Progress Bar while loading */}
        {loading && progress && (
          <div className="bar progress-bar">
            <span>
              Page {progress.pages} — {progress.items}
              {progress.expected ? ` / ${progress.expected}` : ''} items fetched…
            </span>
          </div>
        )}

        {/* 3. Viewing Bar */}
        {!loading && viewing && (
          <div className="bar viewing-bar">
            <span>
              Viewing saved fetch from {fmtDateTime(viewing.savedAt)} ({viewing.count}{' '}
              items). Exports use this saved data.
            </span>
            <button className="btn btn-ghost" onClick={() => setViewing(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* 4. Done Bar */}
        {!loading && progress && (
          <div className="bar done-bar">
            <span>
              Done — {progress.items} items across {progress.pages} pages
              {progress.expected > 0 &&
                (progress.items >= progress.expected - 5
                  ? ` (server reports ${progress.expected} total — complete)`
                  : ' — short, run again')}
              {saveMsg ? ` ${saveMsg}` : ''}
            </span>
          </div>
        )}

        {/* 5. Error Box */}
        {error && (
          <div className="error-box">
            <div>
              <strong>Error:</strong> {error}
            </div>
            <div className="error-hint">
              Make sure the Vite dev server is running (<code>npm run dev</code>) for the
              proxy to work.
            </div>
          </div>
        )}

        {/* 6. Toolbar */}
        {allItems.length > 0 && (
          <>
            <div className="toolbar">
              <div className="tabs-group">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
                    onClick={() => handleTabChange(tab.id)}
                  >
                    {tab.label}
                    <span className="tab-count">{counts[tab.id]}</span>
                  </button>
                ))}
              </div>

              <div className="search-wrap">
                <input
                  type="search"
                  className="search-input"
                  placeholder="Search name, publisher, description…"
                  aria-label="Search results"
                  value={query}
                  onChange={handleQueryChange}
                />
              </div>

              <div className="toolbar-right">
                <span>
                  {displayItems.length === 0
                    ? '0 results'
                    : `${rangeA}–${rangeB} of ${displayItems.length}`}
                </span>
                {rawSample && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setRawVisible(!rawVisible)}
                  >
                    {rawVisible ? 'Hide' : 'Inspect raw API sample'}
                  </button>
                )}
              </div>
            </div>

            {rawVisible && rawSample && (
              <pre className="raw-sample-pre">{rawSampleText}</pre>
            )}
          </>
        )}

        {/* 7. Table */}
        {allItems.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Components</th>
                  <th>MCP endpoint</th>
                  <th>Taxonomy</th>
                  <th>Publisher</th>
                  <th>Tier</th>
                  <th>Added</th>
                  <th>Updated</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {displayItems.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="empty-cell">
                      No results match “{query}”.
                    </td>
                  </tr>
                ) : (
                  pageItems.map((item, idx) => {
                    const endpoints = getEndpoints(item);
                    let epDisplay = '—';
                    if (endpoints.length > 0) {
                      const firstShort = shorten(endpoints[0], 42);
                      const more =
                        endpoints.length > 1 ? ` +${endpoints.length - 1} more` : '';
                      epDisplay = (
                        <span className="mono-cell" title={endpoints.join('\n')}>
                          {firstShort}
                          {more}
                        </span>
                      );
                    }

                    const primaryTax = primaryTaxonomy(item);
                    const allTax = allTaxValues(item);
                    const otherTax = primaryTax
                      ? allTax.filter((t) => t !== primaryTax)
                      : allTax;

                    const descText = item?.summary || item?.description || '';
                    const catName = classify(item);

                    return (
                      <tr key={item.id || idx}>
                        <td>
                          <button
                            className="name-btn"
                            onClick={() => setSelected(item)}
                          >
                            {item.name || item.title || 'Untitled'}
                          </button>
                        </td>
                        <td>
                          <span className={`cat cat--${catName.toLowerCase()}`}>
                            {catName}
                          </span>
                        </td>
                        <td className="mono-cell">{getRawType(item)}</td>
                        <td>{epDisplay}</td>
                        <td>
                          {primaryTax || otherTax.length > 0 ? (
                            <div className="tax-cell">
                              {primaryTax && (
                                <span className="tax-chip-primary">{primaryTax}</span>
                              )}
                              {otherTax.length > 0 && (
                                <span className="tax-others">
                                  {otherTax.map(humanize).join(', ')}
                                </span>
                              )}
                            </div>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{item.publisher?.name || '—'}</td>
                        <td>{item.verified_tier || '—'}</td>
                        <td title={item.added_time || ''}>{fmtDate(item.added_time)}</td>
                        <td title={item.updated_time || ''}>
                          {fmtDate(item.updated_time)}
                        </td>
                        <td className="desc-cell" title={descText}>
                          {shorten(descText, 120) || '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* 8. Pagination */}
        {totalPages > 1 && (
          <div className="pagination">
            <button
              className="btn btn-ghost"
              onClick={() => setPage(1)}
              disabled={currentPage === 1}
            >
              « First
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              ‹ Prev
            </button>
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              Next ›
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => setPage(totalPages)}
              disabled={currentPage === totalPages}
            >
              Last »
            </button>
          </div>
        )}

        {/* 9. Empty State */}
        {!loading && allItems.length === 0 && !error && (
          <div className="empty-state">
            <p>
              Click <strong>Fetch All Pages</strong> to begin. It will keep paginating
              until the API returns no more results.
            </p>
          </div>
        )}
      </main>

      {/* Item Detail Modal */}
      {selected && (
        <ItemModal item={selected} onClose={() => setSelected(null)} />
      )}

      {/* History Modal */}
      {historyOpen && (
        <HistoryModal
          history={history}
          onClose={() => setHistoryOpen(false)}
          onView={viewSnapshot}
          onRemove={removeSnapshot}
          historyBusy={historyBusy}
          historyError={historyError}
        />
      )}
    </div>
  );
}
