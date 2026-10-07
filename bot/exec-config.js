// ----------------------------------------------------------------------------
// bot/exec-config.js — Execution readiness gate
//
// Live swap execution remains DISABLED until BOTH conditions are true:
//   1. env.RUN_EXECUTION_SECRET is present and at least 16 characters long.
//   2. env.EXECUTION_ENABLED is exactly "1".
//
// This matches RavenOS policy that execution paths are opt-in and secret-gated
// (see lib/agentic_trading/records.mjs which forbids secret-key fields in
// records, and lib/customer_product.mjs product-flag gating).
//
// SECURITY: RUN_EXECUTION_SECRET is never logged. Helper maskSecret() obscures
// any value in telemetry output.
// ----------------------------------------------------------------------------
'use strict';

export const EXECUTION_MODE = Object.freeze({
  SIMULATED: 'simulated',
  PAPER: 'paper',
  LIVE: 'live',
});

export function executionReadiness(env = {}) {
  const secret = typeof env.RUN_EXECUTION_SECRET === 'string' ? env.RUN_EXECUTION_SECRET : '';
  const hasSecret = secret.length >= 16;
  const enabled = String(env?.EXECUTION_ENABLED || '').toUpperCase() === '1';

  if (enabled && hasSecret) {
    return {
      mode: EXECUTION_MODE.LIVE,
      executionEnabled: true,
      hasSecret: true,
      ready: true,
      reason: null,
      maskSecret: maskSecret(secret),
    };
  }

  let reason;
  if (!enabled) {
    reason = 'EXECUTION_ENABLED is not "1", live execution is disabled';
  } else if (!hasSecret) {
    reason = 'RUN_EXECUTION_SECRET is missing or too short (>= 16 chars required)';
  } else {
    reason = 'execution readiness check failed';
  }

  return {
    mode: EXECUTION_MODE.SIMULATED,
    executionEnabled: false,
    hasSecret: false,
    ready: false,
    reason,
    maskSecret: maskSecret(secret),
  };
}

export function maskSecret(value) {
  if (!value) return '';
  return '*'.repeat(12);
}
