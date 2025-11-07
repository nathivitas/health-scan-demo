# Health Scan Demo (POC) — Dry-Run vs Real

**Author:** Naty Caraballo  
**Scope:** Proof-of-concept demonstrating **dry-run** (no mutations) vs **real** (mutations + lock + cooldown), backed by Redis.

> Heads-up: this is a POC. The UI is intentionally minimal. This repo is about correctness of backend behavior, not visual polish. Apologies in advance.

---

## What this demonstrates

| Mode | Mutates Redis? | Returns Report? | Notes |
|------|---------------|----------------|------|
| **Dry-run** | No | Yes | Always allowed. No cooldown, no quota impact. |
| **Real** | Yes | Yes | Enforces quota + cooldown + in-flight lock. |

### Redis gates:
- **Cooldown:** 120 seconds (POC). Blocks only **real** scans.
- **Quota:** `scans_allowed` per **rolling 24 hours**.
- **Eligibility:**  
  ```text
  real_eligible_now = (!cooldown_active) && (scans_used_in_window < scans_allowed)
  ```

---

## Prerequisites (macOS)

Assumptions: Running on macOS with developer tooling.

- Node.js 18+
- Homebrew
- Redis (local)

Install Redis and start it:

```bash
brew install redis
brew services start redis
```

Verify it’s running:

```bash
redis-cli PING
# PONG
```

---

## Directory Layout

```
health-scan-demo/
├─ server/
│  ├─ index.js               # Node/Express API (dry-run vs real, Redis gates)
│  └─ db/
│     ├─ accounts.json       # mock accounts
│     ├─ policies.json       # package → scans_allowed, enablement flags
│     ├─ features.json       # optional per-user overrides
│     └─ keywords.json       # search-term → normalized product mapping
└─ client/
   ├─ src/
   │  ├─ App.jsx             # UI logic (dry-run + real)
   │  └─ api.js              # REST fetch helpers
   ├─ index.html
   └─ vite.config.js         # /api → http://localhost:3001 proxy
```

---

# Health Scan Demo (dry-run vs real)

End-to-end demo with:
- **Node/Express API** that implements dry-run (`no mutations`) vs real-run (`mutations + lock + cooldown`).
- **Redis** (local) for cooldowns, counters, locks, and a simple features cache.
- **React (Vite)** client with a single button that reflects eligibility and triggers real scans.
- **File-based DB** under `server/db/` to simulate accounts, policies, features, and keyword→category mapping.

---


## How to Run

### 1) Start the API

```bash
cd server
npm install
npm run dev
# API listening on http://localhost:3001
```

### 2) Start the UI

```bash
cd ../client
npm install
npm run dev
# UI on http://localhost:5173
```

The UI is already configured to use the `/api` proxy; no URL changes required.

---

## What to Try

1) In the UI, select account **LOC12345**.  
   Click **“Check eligibility (dry-run)”**:
   - A **report** appears.
   - You see `scans_used_in_window / scans_allowed`.
   - Real button reflects `real_eligible_now`.

2) Click **“Run Scan (real)”**:
   - The API returns a **real** report.
   - **Quota consumption** and **cooldown** are applied.
   - UI refreshes eligibility accordingly.

3) Wait ~120 seconds and trigger again to confirm cooldown expiration.

---

## Resetting State (useful in testing)

```bash
redis-cli FLUSHALL
```

Or reset a single account:

```bash
redis-cli DEL user:LOC12345:cooldown user:LOC12345:count user:LOC12345:features
```

Check TTLs:

```bash
redis-cli TTL user:LOC12345:cooldown
redis-cli TTL user:LOC12345:count
```

---

## API Reference (Local)

### Trigger Scan
```
POST http://localhost:3001/api/health-scores/trigger?dry_run=true|false
```

Body:
```json
{
  "mc_id": "LOC12345",
  "section": "insites",
  "search_terms": ["roofing", "gutters"]
}
```

Example response excerpt:
```json
{
  "accepted": true,
  "real_eligible_now": false,
  "cooldown_active": true,
  "cooldown_expires_at": "2025-11-07T01:36:07.166Z",
  "scans_allowed": 3,
  "scans_used_in_window": 1,
  "report": { "... mock result ..." }
}
```
## API endpoints (local)

- `POST http://localhost:3001/api/health-scores/trigger?dry_run=true|false`
  - Body: `{"mc_id":"LOC12345","section":"insites","search_terms":["roofing","gutters"]}`
- `GET  http://localhost:3001/api/db`

---

## File DB knobs

- `server/db/policies.json`: set `scans_allowed` per package; enable/disable sections per package.
- `server/db/accounts.json`: add/change accounts and package tiers.
- `server/db/features.json`: pre-seed features cache behavior for specific `mc_id`s.
- `server/db/keywords.json`: map free-form search terms to normalized product categories.

## Notes

- 24h is used as the **billing window** end for TTL alignment (mocking Recurly).
- `dry_run=true` never writes to Redis, never locks, never adjusts TTLs.
- `dry_run=false` performs the full real flow and sets a 2min cooldown.


## Policy Model (POC)

- Enablement is package-driven (`policies.json`).
- Quota is **rolling 24h**:
  - First real scan → sets counter = 1 and TTL = 24h.
  - Subsequent real scans → increment and refresh TTL back to 24h.
- Cooldown applies **only** to real scans and lasts **120 seconds**.

```text
real_eligible_now = (!cooldown_active) && (scans_used_in_window < scans_allowed)
```

---

## Important Notes

- All timestamps in API responses are **UTC ISO-8601** (`...Z`).
- UI converts or displays raw ISO; adjust in UI if time-zone-specific UX is needed.
- The UI is deliberately minimal—meant to visualize gating logic, not replace a frontend.

---

## Why This Exists

To prove:
- Dry-run and Real can share logic but have different *side effects*
- State gating is clean, explicit, and observable via Redis TTLs/counters
- Cooldown + rolling quota + in-flight locks are simple and composable

---
Happy debugging!!
