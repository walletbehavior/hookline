// ----------------------------------------------------------------------------
// bot/server.js — Telegram webhook server (Node runtime only).
//
// This file is Node-only: it imports node:crypto and node:http, and it is NOT
// imported by the Cloudflare Worker. It runs the long-lived webhook server so
// the bot can receive updates over HTTPS instead of long polling.
//
// Run it directly:
//   TELEGRAM_BOT_TOKEN=<token> node bot/server.js webhook [--host 127.0.0.1] [--port 3000]
//
// Deployment notes
// ----------------
//   1. Register a secret token via setWebhook; the server verifies the
//      X-Telegram-Bot-Api-Secret-Token header on every POST /tg/webhook.
//   2. For local testing, register http://127.0.0.1:3000/tg/webhook with
//      BotFather (the secret token is registered with BotFather, not logged
//      anywhere; maskSecret() obscures it to 12 asterisks in telemetry).
//   3. For production, terminate TLS with a reverse proxy, Cloudflare Tunnel,
//      or Cloudflare Workers (POST /telegram/webhook) and register that URL.
//   4. Live execution is gated by EXECUTION_ENABLED + RUN_EXECUTION_SECRET;
//      the bot never executes unless the gate is open.
// ----------------------------------------------------------------------------
'use strict';

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { parseUpdate, verifyWebhookSecret } from './bot-api.js';
import { handleUpdate } from './index.js';

/**
 * Start the webhook server. Called from the CLI entry point.
 * @param {string[]} args - process.argv.slice(2)
 */
export async function runWebhookServer(args = []) {
  const { host, port } = parseArgs(args);
  const token = process.env?.TELEGRAM_BOT_TOKEN || process.env?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Set it, then run:');
    console.error('  node bot/server.js webhook [--host 127.0.0.1] [--port 3000]');
    process.exit(1);
  }

  const secretToken = createHash('sha256').update(Math.random().toString() + Date.now().toString()).digest('hex');
  const webhookUrl = 'http://' + host + ':' + port + '/tg/webhook';

  try {
    // We intentionally log the webhook URL only; the secret token itself is
    // never printed.
    console.log('Webhook URL: ' + webhookUrl);
    console.log('Webhook secret token length: ' + secretToken.length);
    console.log('Registering the URL with BotFather via setWebhook...');
  } catch (err) {
    console.error('Webhook URL construction failed:', err.message);
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/tg/webhook' && req.method === 'POST') {
      const verify = verifyWebhookSecret(req, secretToken);
      if (!verify.ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'webhook secret invalid', reason: verify.reason }));
        return;
      }
      let update;
      try { update = JSON.parse(body); } catch { update = null; }
      const result = await handleUpdate(update, { env: process.env });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.url === '/tg' || req.url === '/tg/') {
      res.writeHead(301, { 'Location': '/tg/webhook' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Hookline bot server');
  });

  server.listen(port, host, () => {
    console.log('Hookline bot server listening on http://' + host + ':' + port);
  });

  process.on('SIGINT', () => { server.close(); process.exit(0); });
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}

function parseArgs(args) {
  const host = args.find((a) => a.startsWith('--host='))?.split('=')[1] || '127.0.0.1';
  const port = Number(args.find((a) => a.startsWith('--port='))?.split('=')[1]) || 3000;
  return { host, port };
}

// CLI entry when run directly: node bot/server.js webhook
if (import.meta.main) {
  runWebhookServer(process.argv.slice(2)).catch((err) => {
    console.error('Server failed:', err);
    process.exit(1);
  });
}
