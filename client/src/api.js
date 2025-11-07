// UI calls this API through Vite dev proxy.
// vite.config.js should contain:
//   proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } }
const API = '/api';

// Generic fetch helper
async function handle(r) {
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText}\n${text}`);
  }
  return r.json();
}

/**
 * Read file-backed mock DB for selector dropdowns.
 */
export async function fetchDb() {
  return handle(await fetch(`${API}/db`));
}

/**
 * Dry-run:
 * - Executes scan processing server-side
 * - Returns full `report` and eligibility flags
 * - Does not modify Redis (no quota, no cooldown, no lock)
 * - Always allowed
 */
export async function dryRun(mc_id, section = 'insites', payload = {}) {
  return handle(
    await fetch(`${API}/health-scores/trigger?dry_run=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mc_id, section, ...payload })
    })
  );
}

/**
 * Real run:
 * - Requires: real_eligible_now === true (checked in UI)
 * - Increments usage in rolling 24h window
 * - Applies cooldown (120s for POC)
 * - Returns full `report`
 * - Mutates Redis state
 */
export async function trigger(mc_id, section = 'insites', payload = {}) {
  return handle(
    await fetch(`${API}/health-scores/trigger?dry_run=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mc_id, section, ...payload })
    })
  );
}
