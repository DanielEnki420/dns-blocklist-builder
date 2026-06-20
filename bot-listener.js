#!/usr/bin/env node
'use strict';
// bot-listener.js — Telegram command bot for Pi5 HomeLab
// Runs as a systemd service, long-polls Telegram, responds to commands.
//
// Commands: /status  /update  /stats  /help

const https       = require('https');
const { spawn }   = require('child_process');
const { execSync } = require('child_process');
const fs          = require('fs');
const path        = require('path');

const INSTALL_DIR   = __dirname;
const TELEGRAM_CFG  = path.join(INSTALL_DIR, '.telegram');
const PIHOLE_LIST   = path.join(INSTALL_DIR, 'lists', 'blocklist-all.pihole.txt');
const BY_CAT_DIR    = path.join(INSTALL_DIR, 'lists', 'by-category');
const UPDATE_SCRIPT = path.join(INSTALL_DIR, 'update-pi5.sh');
const POLL_TIMEOUT  = 25; // seconds (keep below OS TCP timeout)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const raw    = fs.readFileSync(TELEGRAM_CFG, 'utf8');
  const token  = (raw.match(/BOT_TOKEN=(.+)/) || [])[1]?.trim();
  const chatId = (raw.match(/CHAT_ID=(.+)/)   || [])[1]?.trim();
  if (!token || !chatId) throw new Error('.telegram: missing BOT_TOKEN or CHAT_ID');
  return { token, chatId };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function apiGet(token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const p = {};
    for (const [k, v] of Object.entries(params))
      p[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
    const qs = new URLSearchParams(p).toString();
    const req = https.get(
      `https://api.telegram.org/bot${token}/${method}?${qs}`,
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }
    );
    req.on('error', reject);
    req.setTimeout((POLL_TIMEOUT + 10) * 1000, () => req.destroy(new Error('timeout')));
  });
}

function apiPost(token, method, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function send(token, chatId, text) {
  return apiPost(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function countDomains(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(l => l && !l.startsWith('#') && l.trim()).length;
  } catch { return 0; }
}

function lastGitDate() {
  try {
    return execSync(`git -C "${INSTALL_DIR}" log -1 --format="%ci"`)
      .toString().trim().substring(0, 16);
  } catch { return 'unknown'; }
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdStatus(token, chatId) {
  const total = countDomains(PIHOLE_LIST);
  await send(token, chatId,
    `🛡 <b>DNS Blocklist Builder</b>\n` +
    `📊 ${total} domains blocked\n` +
    `🕐 Last update: ${lastGitDate()}\n` +
    `⏭ Next auto-update: Monday 03:00 UTC`
  );
}

async function cmdStats(token, chatId) {
  const total = countDomains(PIHOLE_LIST);
  const cats = fs.readdirSync(BY_CAT_DIR)
    .filter(f => f.endsWith('.pihole.txt'))
    .map(f => {
      const file      = path.join(BY_CAT_DIR, f);
      const firstLines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 10);
      const nameLine  = firstLines.find(l => l.includes('DNS Blocklist Builder –'));
      const name      = nameLine
        ? nameLine.replace(/^#\s*DNS Blocklist Builder\s*–\s*/, '').trim()
        : f.replace('.pihole.txt', '');
      return { name, count: countDomains(file) };
    })
    .sort((a, b) => b.count - a.count);

  const lines = cats.map(c => `• ${c.name}: ${c.count}`).join('\n');
  await send(token, chatId, `📊 <b>Domains by category</b>\n\n${lines}\n\n📦 Total: ${total}`);
}

let updateRunning = false;

async function cmdUpdate(token, chatId) {
  if (updateRunning) {
    await send(token, chatId, '⏳ Update already running — please wait');
    return;
  }
  updateRunning = true;
  await send(token, chatId, '🔄 Update started…');

  const child = spawn('bash', [UPDATE_SCRIPT], { stdio: 'pipe' });
  child.on('close', async code => {
    updateRunning = false;
    // update-pi5.sh sends its own Telegram notification on success;
    // only notify here on failure.
    if (code !== 0)
      await send(token, chatId, `❌ Update failed (exit ${code})`);
  });
  child.on('error', async err => {
    updateRunning = false;
    await send(token, chatId, `❌ Could not start update: ${err.message}`);
  });
}

async function cmdHelp(token, chatId) {
  await send(token, chatId,
    `🤖 <b>Pi5HomeLab Bot</b>\n\n` +
    `/status — Domain count &amp; last update\n` +
    `/update — Trigger update now\n` +
    `/stats  — Breakdown by category\n` +
    `/help   — This message`
  );
}

// ── Polling loop ──────────────────────────────────────────────────────────────
async function main() {
  const { token, chatId } = loadConfig();
  console.log(`[${new Date().toISOString()}] Pi5HomeLab bot started`);

  let offset = 0;
  while (true) {
    try {
      const res = await apiGet(token, 'getUpdates', {
        offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message'],
      });

      if (!res.ok) {
        console.error(`API error: ${res.description}`);
        await sleep(5000);
        continue;
      }

      for (const update of res.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        if (String(msg.chat.id) !== chatId) continue; // ignore strangers

        // Strip bot username suffix, e.g. /start@Pi5HoMeLaB_Bot
        const cmd = msg.text.split('@')[0].split(' ')[0].toLowerCase();
        console.log(`[${new Date().toISOString()}] ${cmd}`);

        if      (cmd === '/status')                await cmdStatus(token, chatId);
        else if (cmd === '/stats')                 await cmdStats(token, chatId);
        else if (cmd === '/update')                await cmdUpdate(token, chatId);
        else if (cmd === '/help' || cmd === '/start') await cmdHelp(token, chatId);
        else await send(token, chatId, '❓ Unknown command. Use /help');
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
      await sleep(5000);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
