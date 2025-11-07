const API = '/api';

async function handle(r) {
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText}\n${text}`);
  }
  return r.json();
}

export async function fetchDb() {
  return handle(await fetch(`${API}/db`));
}

// Dry-run: returns report, no mutations, always allowed
export async function dryRun(mc_id, section = 'insites', payload = {}) {
  return handle(
    await fetch(`${API}/health-scores/trigger?dry_run=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mc_id, section, ...payload }),
    }),
  );
}

// Real: gated by dry-run’s real_eligible_now; returns report; mutates state
export async function trigger(mc_id, section = 'insites', payload = {}) {
  return handle(
    await fetch(`${API}/health-scores/trigger?dry_run=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mc_id, section, ...payload }),
    }),
  );
}
