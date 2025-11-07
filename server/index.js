import express from 'express';
import cors from 'cors';
import { createClient } from 'redis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// POC cooldown duration (seconds). Real product would be 86400 (24h).
// For testing we use a short cooldown (120s). Override via env.
const COOLDOWN_SECONDS = Number(process.env.COOLDOWN_SECONDS ?? 120);

// Rolling quota window length (seconds).
// Each REAL scan sets/refreshes the usage counter TTL to this duration.
// This models “scans_allowed per rolling 24 hours”.
const ROLLING_WINDOW_SECONDS = Number(process.env.ROLLING_WINDOW_SECONDS ?? 86400); // 24h

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = (p) => path.join(__dirname, 'db', p);

// Local mock datasets (stand-in for RDS + policy tables)
const ACCOUNTS = JSON.parse(fs.readFileSync(dbPath('accounts.json'), 'utf-8'));
const POLICIES = JSON.parse(fs.readFileSync(dbPath('policies.json'), 'utf-8'));
const FEATURES_FILE = JSON.parse(fs.readFileSync(dbPath('features.json'), 'utf-8'));
const KEYWORDS = JSON.parse(fs.readFileSync(dbPath('keywords.json'), 'utf-8'));

const app = express();
app.use(cors());
app.use(express.json());

// Redis client, using local instance for POC
const redis = createClient();
redis.on('error', (err) => console.error('Redis error', err));
await redis.connect();

// Helpers
const iso = (d) => new Date(d).toISOString();
function nowUtc() { return new Date(); }

// Month-end logic no longer needed → **rolling window replaces it**

// Look up account
function mcAccount(mc_id) {
  return ACCOUNTS.find(a => a.mc_id === mc_id) || null;
}

/**
 * Resolve enablement + quota count allowed for this section.
 * Cached in Redis to avoid re-reading file DB repeatedly.
 */
async function getFeatures(mc_id, section) {
  const key = `user:${mc_id}:features`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const acct = mcAccount(mc_id);
  const pkg = acct?.package ?? 'FREE';
  const scans_allowed = POLICIES.packages[pkg]?.scans_allowed ?? 0;
  const enabled = (POLICIES.sections[section]?.enabled_for || []).includes(pkg);

  const base = { [section]: { enabled }, scans_allowed };
  const merged = FEATURES_FILE[mc_id] ? { ...base, ...FEATURES_FILE[mc_id] } : base;

  await redis.set(key, JSON.stringify(merged));
  return merged;
}

/**
 * Normalize input keyword→canonical product mapping.
 * This is a placeholder for the real business taxonomy service.
 */
function normalizeProducts({ search_terms = [], products = [] }) {
  const raw = []
    .concat(search_terms || [])
    .concat(Array.isArray(products) ? products : products ? [products] : [])
    .map(s => s.toLowerCase().trim().replace(/[^\w\s-]/g, ''));

  const mapped = raw.map(t => KEYWORDS[t] || t);
  return Array.from(new Set(mapped)).filter(Boolean).slice(0, 5);
}

// Debug endpoint consumed by UI to populate selectors
app.get('/api/db', (req, res) => res.json({ accounts: ACCOUNTS, policies: POLICIES }));

/**
 * Core endpoint:
 *
 * dry_run = true:
 *    - Executes scoring logic
 *    - Returns full report + eligibility flags
 *    - Never increments usage or sets cooldown
 *    - Never acquires lock
 *
 * dry_run = false (REAL):
 *    - Requires: no cooldown + scans_used < scans_allowed
 *    - Increments usage counter (with 24h TTL)
 *    - Sets cooldown (120s for POC)
 *    - Returns full report
 */
app.post('/api/health-scores/trigger', async (req, res) => {
  const { mc_id, section = 'insites', search_terms, products } = req.body || {};
  const dry_run = String(req.query.dry_run ?? 'true') === 'true';
  const corr = randomId();

  if (!mc_id) {
    return res.status(400).json({ accepted: false, reason: 'REQ_MISSING_FIELD', message: 'mc_id required' });
  }

  // Cooldown: blocks REAL scans only
  const cooldownKey = `user:${mc_id}:cooldown`;
  const cooldownTtl = await redis.ttl(cooldownKey);
  const cooldown_active = cooldownTtl > 0;
  const cooldown_expires_at = cooldown_active ? iso(Date.now() + cooldownTtl * 1000) : null;

  // Package + entitlement policy
  const feats = await getFeatures(mc_id, section);
  const enabled = feats?.[section]?.enabled === true;
  const scans_allowed = Number(feats?.scans_allowed ?? 0);

  if (!enabled) {
    return res.json({
      accepted: false,
      reason: 'NOT_IN_PACKAGE',
      enabled: false,
      eligible_now: false,
      scans_allowed,
      scans_used_in_window: 0
    });
  }

  // Rolling quota counter
  // If counter exists, read value; if missing, treat as 0 on dry-run and 1 on first real run.
  const countKey = `user:${mc_id}:count`;
  const ttlBefore = await redis.ttl(countKey);
  let scans_used = 0;
  if (ttlBefore > 0) {
    scans_used = Number(await redis.get(countKey) || 0);
  } else {
    scans_used = dry_run ? 0 : 1;
    if (!dry_run) {
      await redis.set(countKey, 1, { EX: ROLLING_WINDOW_SECONDS });
    }
  }

  // Determine eligibility for REAL execution
  const quota_ok = scans_used < scans_allowed;
  const real_eligible_now = !cooldown_active && quota_ok;

  // Normalize requested products
  const prod = normalizeProducts({ search_terms, products });
  const sendProducts = prod.length ? prod : null;

  // Always generate report (dry-run + real)
  const report = generateMockReport({ mc_id, section, products: sendProducts, corr });

  // DRY-RUN: read-only evaluation
  if (dry_run) {
    return res.json({
      accepted: true,
      reason: 'OK',
      enabled: true,
      eligible_now: true,
      real_eligible_now,
      cooldown_active,
      cooldown_expires_at,
      scans_allowed,
      scans_used_in_window: scans_used,
      products: sendProducts || [],
      report
    });
  }

  // REAL run gating
  if (!real_eligible_now) {
    return res.json({
      accepted: false,
      reason: cooldown_active ? 'COOLDOWN' : 'SCAN_QUOTA_EXCEEDED',
      enabled: true,
      eligible_now: false,
      cooldown_expires_at,
      scans_allowed,
      scans_used_in_window: scans_used
    });
  }

  // In-flight lock protects real trigger side effects
  const lockKey = `user:lock:${mc_id}:${section}`;
  const lock = await redis.set(lockKey, corr, { NX: true, EX: 90 });
  if (!lock) {
    return res.json({ accepted: false, reason: 'IN_FLIGHT', message: 'Another scan in progress' });
  }

  try {
    // If counter existed, increment it; otherwise first scan already created countKey above
    if (ttlBefore > 0) {
      scans_used = await redis.incr(countKey);
      await redis.expire(countKey, ROLLING_WINDOW_SECONDS); // refresh TTL to full window
    }

    // Apply cooldown after real scan completes
    await redis.set(cooldownKey, '1', { EX: COOLDOWN_SECONDS });
    const newCooldownTtl = await redis.ttl(cooldownKey);
    const nextCooldownEnd = iso(Date.now() + newCooldownTtl * 1000);

    return res.json({
      accepted: true,
      reason: 'OK',
      enabled: true,
      eligible_now: false, // real runs automatically become ineligible immediately due to cooldown
      cooldown_expires_at: nextCooldownEnd,
      scans_allowed,
      scans_used_in_window: scans_used,
      products: sendProducts || [],
      report // return real scan report
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
    scored_at: iso(Date.now()),
    summary: {
      score: Math.floor(70 + Math.random() * 25),
      findings: Math.floor(2 + Math.random() * 6)
    }
  };
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
