import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeRequest, LabError } from './lab.mjs';

const htmlPath = fileURLToPath(new URL('./index.html', import.meta.url));

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 32 * 1024) throw new LabError(413, 'request_too_large', 'The local request body exceeds 32 KiB.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new LabError(400, 'invalid_json', 'Send a valid JSON request body.');
  }
}

export async function createLabServer({ execute = executeRequest, logger = console } = {}) {
  const html = await readFile(htmlPath, 'utf8');
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => `'sha256-${createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64')}'`).join(' ');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${hashes}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const port = server.address()?.port;
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      json(response, 403, { error: { code: 'invalid_host', message: 'Use the local lab address.' } });
      return;
    }
    try {
      if (request.method === 'GET' && request.url === '/api/health') {
        json(response, 200, { status: 'ok', readOnly: true });
      } else if (request.method === 'GET' && (request.url === '/' || request.url?.startsWith('/?') || request.url === '/index.html')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
      } else if (request.method === 'GET' && request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
      } else if (request.method === 'POST' && request.url === '/api/execute') {
        if (request.headers.origin !== `http://${host}` || request.headers['x-lab-request'] !== '1') {
          throw new LabError(403, 'invalid_origin', 'Only requests from the local lab UI are accepted.');
        }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          throw new LabError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
        }
        const result = await execute(await readJson(request));
        json(response, 200, result);
      } else {
        json(response, 404, { error: { code: 'not_found', message: 'Route not found. This lab exposes only conversation and response read operations.' } });
      }
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof LabError) {
        logger.warn(`[lab] ${error.code} (HTTP ${error.status})`);
        json(response, error.status, { ...error.details, error: { code: error.code, message: error.message } });
      } else {
        logger.error('[lab] Unexpected local server failure.', error);
        json(response, 500, { error: { code: 'internal_error', message: 'Unexpected local server failure. See the server console.' } });
      }
    }
  });
  server.requestTimeout = 100000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const server = await createLabServer();
  server.on('error', error => {
    console.error(`[lab] Cannot start: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Foundry Conversations & Responses Lab: http://127.0.0.1:${port}`);
    console.log('Read-only. Press Ctrl+C to stop.');
  });
}
