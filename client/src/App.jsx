import { useEffect, useMemo, useState } from 'react';
import { fetchDb, dryRun, trigger } from './api';

export default function App() {
  const [db, setDb] = useState(null);
  const [mcId, setMcId] = useState('LOC12345');
  const [section, setSection] = useState('insites');

  const [elig, setElig] = useState(null);        // state returned from dry-run (controls real button)
  const [dryReport, setDryReport] = useState(null);
  const [realReport, setRealReport] = useState(null);

  const [terms, setTerms] = useState('Roofing, Gutters');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Load DB for dropdowns
  useEffect(() => {
    fetchDb().then(setDb).catch(e => setError(String(e)));
  }, []);

  const account = useMemo(
    () => db?.accounts?.find(a => a.mc_id === mcId),
    [db, mcId]
  );

  // Always allowed — never consumes quota — returns report + eligibility state
  async function runDry() {
    setError(null);
    setLoading(true);
    try {
      const res = await dryRun(mcId, section, { search_terms: toArray(terms) });
      setElig(res);
      setDryReport(res.report || null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Real scan — consumes quota + sets cooldown — returns real scan report
  async function runReal() {
    setError(null);
    setLoading(true);
    try {
      const res = await trigger(mcId, section, { search_terms: toArray(terms) });
      setRealReport(res.report || null);
      // After real run, refresh eligibility state via new dry-run
      const updated = await dryRun(mcId, section, { search_terms: toArray(terms) });
      setElig(updated);
      setDryReport(updated.report || null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Auto-check on account/section change
  useEffect(() => {
    runDry();
    // eslint-disable-next-line
  }, [mcId, section]);

  // Enable Real button only when backend says real_eligible_now = true
  const realEnabled = !!elig?.real_eligible_now;

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>Health Scan Demo</h1>

      {/* Controls */}
      <div className="card" style={card}>
        <div style={row}>
          <label>MC ID:&nbsp;
            <select value={mcId} onChange={e => setMcId(e.target.value)}>
              {db?.accounts?.map(a => (
                <option key={a.mc_id} value={a.mc_id}>
                  {a.mc_id} — {a.legal_name}
                </option>
              ))}
            </select>
          </label>

          <label>Section:&nbsp;
            <select value={section} onChange={e => setSection(e.target.value)}>
              <option value="insites">insites</option>
            </select>
          </label>

          <label>Keywords/Products:&nbsp;
            <input
              value={terms}
              onChange={e => setTerms(e.target.value)}
              placeholder="roofing, gutters"
              style={{ minWidth: 240 }}
            />
          </label>

          <button className="btn" onClick={runDry} disabled={loading} style={btn}>
            Check eligibility (dry-run)
          </button>
        </div>
      </div>

      {error && (
        <div className="card" style={{ ...card, borderColor: '#e00' }}>
          <strong>Error:</strong>
          <pre style={mono}>{error}</pre>
        </div>
      )}

      {/* Account info */}
      <div className="card" style={card}>
        <h3>Account</h3>
        {account ? (
          <ul>
            <li><b>mc_id:</b> <code>{account.mc_id}</code></li>
            <li><b>legal_name:</b> {account.legal_name}</li>
            <li><b>package:</b> <code>{account.package}</code></li>
            <li><b>website:</b> <a href={account.website} target="_blank" rel="noreferrer">{account.website}</a></li>
          </ul>
        ) : <i>No account found</i>}
      </div>

      {/* Eligibility snapshot */}
      <div className="card" style={card}>
        <h3>Eligibility (from dry-run)</h3>
        {elig ? (
          <>
            <div style={row}>
              <div><b>enabled:</b> {String(elig.enabled)}</div>
              <div><b>real_eligible_now (controls real button):</b> {String(elig.real_eligible_now)}</div>
            </div>

            <div style={row}>
              <div><b>cooldown:</b> {elig.cooldown_active ? `active until ${elig.cooldown_expires_at}` : 'none'}</div>
              <div><b>usage (last 24h):</b> {elig.scans_used_in_window} / {elig.scans_allowed}</div>
            </div>

            {elig.products?.length ? (
              <div style={row}><b>products:</b> <code>{JSON.stringify(elig.products)}</code></div>
            ) : null}
          </>
        ) : <i>Loading…</i>}
      </div>

      {/* Dry-run report */}
      <div className="card" style={card}>
        <h3>Simulated Report (dry-run)</h3>
        {dryReport ? (
          <pre style={mono}>{JSON.stringify(dryReport, null, 2)}</pre>
        ) : (
          <i>Click “Check eligibility (dry-run)” to generate preview.</i>
        )}
      </div>

      {/* Real trigger */}
      <div className="card" style={card}>
        <h3>Trigger (real)</h3>
        <button
          className="btn"
          onClick={runReal}
          disabled={!realEnabled || loading}
          style={realEnabled ? btn : btnDisabled}
        >
          {realEnabled ? 'Run Scan (real)' : 'Not eligible'}
        </button>

        {realReport && (
          <>
            <h4>Last Real Report</h4>
            <pre style={mono}>{JSON.stringify(realReport, null, 2)}</pre>
          </>
        )}
      </div>
    </div>
  );
}

// Utilities
function toArray(s) {
  return s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
}

// UI styles (minimal + consistent)
const card = { border: '1px solid #ddd', borderRadius: 12, padding: 16, marginBottom: 16 };
const row = { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' };
const mono = { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, SFMono-Regular, monospace' };
const btn = { padding: '8px 12px', borderRadius: 6, cursor: 'pointer' };
const btnDisabled = { ...btn, opacity: 0.4, cursor: 'not-allowed' };
