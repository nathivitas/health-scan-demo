import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- POC gates ---
// Cooldown after REAL scans (seconds). POC = 120s.
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS ?? 120);
// Rolling quota window (seconds). POC = 24h.
const ROLLING_WINDOW_SECONDS = Number(process.env.ROLLING_WINDOW_SECONDS ?? 86400);

// Log effective config
console.log(
  `[CONFIG] COOLDOWN_SECONDS=${COOLDOWN_SECONDS} ROLLING_WINDOW_SECONDS=${ROLLING_WINDOW_SECONDS}`,
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = (p) => path.join(__dirname, 'db', p);

// File-backed mock DB
const ACCOUNTS = JSON.parse(fs.readFileSync(dbPath('accounts.json'), 'utf-8'));
const POLICIES = JSON.parse(fs.readFileSync(dbPath('policies.json'), 'utf-8'));
const FEATURES_FILE = JSON.parse(fs.readFileSync(dbPath('features.json'), 'utf-8'));
const KEYWORDS = JSON.parse(fs.readFileSync(dbPath('keywords.json'), 'utf-8'));

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.type('text').send('Health Scan Demo API'));

// Redis (local)
const redis = createClient();
redis.on('error', (err) => console.error('Redis error', err));
await redis.connect();

// Helpers
const iso = (d) => new Date(d).toISOString();
function nowUtc() {
  return new Date();
}
function mcAccount(mc_id) {
  return ACCOUNTS.find((a) => a.mc_id === mc_id) || null;
}

// Resolve enablement + scans_allowed; cached per user
async function getFeatures(mc_id, section) {
  const key = `user:${mc_id}:features`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const acct = mcAccount(mc_id);
  const pkg = acct?.package ?? 'FREE';
  const scans_allowed = POLICIES.packages[pkg]?.scans_allowed ?? 0;
  const enabled = (POLICIES.sections[section]?.enabled_for || []).includes(pkg);

  const base = { [section]: { enabled }, scans_allowed };
  const out = FEATURES_FILE[mc_id] ? { ...base, ...FEATURES_FILE[mc_id] } : base;

  await redis.set(key, JSON.stringify(out));
  return out;
}

// Normalize keywords/products → canonical categories
function normalizeProducts({ search_terms = [], products = [] }) {
  const raw = []
    .concat(search_terms || [])
    .concat(Array.isArray(products) ? products : products ? [products] : [])
    .map((s) => s.toLowerCase().trim().replace(/[^\w\s-]/g, ''));
  const mapped = raw.map((t) => KEYWORDS[t] || t);
  return Array.from(new Set(mapped)).filter(Boolean).slice(0, 5);
}

// Debug: mock DB for UI dropdowns
app.get('/api/db', (req, res) => res.json({ accounts: ACCOUNTS, policies: POLICIES }));

// Debug: inspect current Redis state (no mutations)
app.get('/api/debug/state', async (req, res) => {
  const mc_id = req.query.mc_id;
  if (!mc_id) return res.status(400).json({ error: 'mc_id required' });
  const cooldownKey = `user:${mc_id}:cooldown`;
  const countKey = `user:${mc_id}:count`;
  const ttlCooldown = await redis.ttl(cooldownKey);
  const ttlCount = await redis.ttl(countKey);
  const countVal = await redis.get(countKey);
  res.json({
    mc_id,
    cooldown_ttl_s: ttlCooldown,
    count_value: Number(countVal || 0),
    count_ttl_s: ttlCount,
    now_utc: iso(nowUtc()),
  });
});

/**
 * POST /api/health-scores/trigger?dry_run=true|false
 *
 * Dry-run (always allowed):
 *   - Executes scan logic and returns report + flags
 *   - No Redis mutations (no counter, no cooldown, no lock)
 *   - Works even when section NOT enabled or plan has 0 scans_allowed
 *
 * Real:
 *   - Requires: enabled === true AND scans_allowed > 0 AND !cooldown AND scans_used < scans_allowed
 *   - Increments rolling 24h counter (sets/refreshes TTL)
 *   - Sets cooldown (COOLDOWN_SECONDS)
 *   - Returns report
 */
app.post('/api/health-scores/trigger', async (req, res) => {
  const { mc_id, section = 'insites', search_terms, products } = req.body || {};
  const dry_run = String(req.query.dry_run ?? 'true') === 'true';
  const corr = randomId();

  if (!mc_id) {
    return res
      .status(400)
      .json({ accepted: false, reason: 'REQ_MISSING_FIELD', message: 'mc_id required' });
  }

  // Cooldown (only applies to REAL)
  const cooldownKey = `user:${mc_id}:cooldown`;
  const cooldownTtl = await redis.ttl(cooldownKey);
  const cooldown_active = cooldownTtl > 0;
  const cooldown_expires_at = cooldown_active ? iso(Date.now() + cooldownTtl * 1000) : null;

  // Policy: enablement + scans_allowed
  const feats = await getFeatures(mc_id, section);
  const enabled = feats?.[section]?.enabled === true;
  const scans_allowed = Number(feats?.scans_allowed ?? 0);
  const authorized_real = scans_allowed > 0; // free-trial (0) → never real

  // Normalize inputs + produce a report for both dry-run and real responses
  const prod = normalizeProducts({ search_terms, products });
  const sendProducts = prod.length ? prod : null;
  const report = generateMockReport({ mc_id, section, products: sendProducts, corr });

  // ---- DRY-RUN: permissive path (always return report, never mutate) ----
  if (dry_run) {
    // For not-enabled or not-authorized plans, real_eligible_now must be false.
    // For enabled+authorized plans, real_eligible_now depends on cooldown/quota.
    let scans_used = 0;

    // If plan is enabled+authorized, reflect current usage in dry-run (still read-only).
    if (enabled && authorized_real) {
      const countKey = `user:${mc_id}:count`;
      const ttl = await redis.ttl(countKey);
      scans_used = ttl > 0 ? Number(await redis.get(countKey) || 0) : 0;
    }

    const quota_ok = scans_used < scans_allowed;
    const real_eligible_now =
      enabled && authorized_real && !cooldown_active && quota_ok;

    return res.json({
      accepted: true,
      reason: 'OK',
      enabled,                     // UI can show if section is in package
      eligible_now: true,          // dry-run itself is always allowed
      real_eligible_now,           // governs REAL button
      cooldown_active,
      cooldown_expires_at,
      scans_allowed,
      scans_used_in_window: scans_used,
      products: sendProducts || [],
      report,
    });
  }

  // ---- REAL: strict gating ----
  // Must be in package
  if (!enabled) {
    return res.json({
      accepted: false,
      reason: 'NOT_IN_PACKAGE',
      enabled: false,
      eligible_now: false,
      scans_allowed,
      scans_used_in_window: 0,
    });
  }
  // Must be authorized for real scans (scans_allowed > 0)
  if (!authorized_real) {
    return res.json({
      accepted: false,
      reason: 'NOT_AUTHORIZED',
      message: 'This plan does not allow real scans.',
      enabled: true,
      eligible_now: false,
      scans_allowed,
      scans_used_in_window: 0,
    });
  }

  // Rolling 24h usage counter
  const countKey = `user:${mc_id}:count`;
  const ttlBefore = await redis.ttl(countKey);
  let scans_used = 0;
  if (ttlBefore > 0) {
    scans_used = Number(await redis.get(countKey) || 0);
  } else {
    scans_used = 1; // consume first scan on first REAL
    await redis.set(countKey, 1, { EX: ROLLING_WINDOW_SECONDS });
  }

  // Eligibility for REAL execution
  const quota_ok = scans_used <= scans_allowed - 1 || ttlBefore > 0; // if we just created, we already consumed #1
  const real_eligible_now = !cooldown_active && quota_ok;

  if (!real_eligible_now) {
    return res.json({
      accepted: false,
      reason: cooldown_active ? 'COOLDOWN' : 'SCAN_QUOTA_EXCEEDED',
      enabled: true,
      eligible_now: false,
      cooldown_expires_at,
      scans_allowed,
      scans_used_in_window: ttlBefore > 0 ? scans_used : 1,
    });
  }

  // In-flight lock
  const lockKey = `user:lock:${mc_id}:${section}`;
  const lock = await redis.set(lockKey, corr, { NX: true, EX: 90 });
  if (!lock) {
    return res.json({ accepted: false, reason: 'IN_FLIGHT', message: 'Another scan in progress' });
  }

  try {
    // If counter existed, increment + refresh TTL to full 24h
    if (ttlBefore > 0) {
      scans_used = await redis.incr(countKey);
      await redis.expire(countKey, ROLLING_WINDOW_SECONDS);
    }

    // Apply cooldown
    await redis.set(cooldownKey, '1', { EX: COOLDOWN_SECONDS });
    const newCooldownTtl = await redis.ttl(cooldownKey);
    const nextCooldownEnd = iso(Date.now() + newCooldownTtl * 1000);

    return res.json({
      accepted: true,
      reason: 'OK',
      enabled: true,
      eligible_now: false, // immediate cooldown after real
      cooldown_expires_at: nextCooldownEnd,
      scans_allowed,
      scans_used_in_window: scans_used,
      products: sendProducts || [],
      report,
    });
  } finally {
    await redis.del(lockKey);
  }
});

// Mock scoring output
function generateMockReport({ mc_id, section, products, corr }) {
  return {
    correlation_id: corr,
    mc_id,
    section,
    products: products || [],
    scored_at: iso(nowUtc()),
    summary: {
      score: Math.floor(70 + Math.random() * 25),
      findings: Math.floor(2 + Math.random() * 6),
    },
  };
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));

