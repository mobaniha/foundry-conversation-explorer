import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const audiences = new Set(['https://ai.azure.com', 'https://cognitiveservices.azure.com']);
const accountPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const identifierPattern = /^[A-Za-z0-9_-]{1,256}$/;
const projectPattern = /^[A-Za-z0-9_-]{1,128}$/;
const listOperations = new Set(['input-items', 'conversations', 'conversation-items']);

export class LabError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function invalid(message) {
  throw new LabError(400, 'invalid_request', message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object.`);
  return value;
}

function text(value, name, maximum = 2048) {
  if (typeof value !== 'string' || value.length > maximum) invalid(`${name} must be a string of at most ${maximum} characters.`);
  return value.trim();
}

function identifier(value, name, pattern = identifierPattern) {
  const result = text(value, name, 256);
  if (!pattern.test(result)) invalid(`${name} must contain only letters, numbers, underscores or hyphens.`);
  return result;
}

export function resolveTarget(target) {
  object(target, 'Target');
  let url;
  if (target.kind === 'account' || target.kind === 'project') {
    const account = text(target.account, 'Account name', 64).toLowerCase();
    if (!accountPattern.test(account)) invalid('Enter an Azure resource account name, not a URL or subscription name.');
    url = new URL(target.kind === 'account'
      ? `https://${account}.openai.azure.com/openai/v1/`
      : `https://${account}.services.ai.azure.com/api/projects/${identifier(target.project, 'Project name', projectPattern)}/openai/v1/`);
  } else if (target.kind === 'endpoint') {
    const endpoint = text(target.endpoint, 'Endpoint');
    try {
      url = new URL(endpoint);
    } catch {
      invalid('Endpoint must be a valid HTTPS Azure endpoint.');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
      invalid('Endpoint must use HTTPS without credentials, a custom port, query parameters or a fragment.');
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.(?:openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/.test(url.hostname)) {
      invalid('Only public Azure OpenAI, AI Services and Foundry account hostnames are supported.');
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '' || path === '/openai/v1') {
      url.pathname = '/openai/v1/';
    } else {
      const match = /^\/api\/projects\/([A-Za-z0-9_-]{1,128})(?:\/openai\/v1)?$/.exec(path);
      if (!match || !url.hostname.endsWith('.services.ai.azure.com')) {
        invalid('Use a resource root, an /openai/v1 endpoint, or a Foundry /api/projects/PROJECT endpoint.');
      }
      url.pathname = `/api/projects/${match[1]}/openai/v1/`;
    }
  } else {
    invalid('Choose account, project or pasted endpoint targeting.');
  }
  return { baseUrl: url.href, projectScoped: url.pathname.startsWith('/api/projects/') };
}

export function prepareRequest(input) {
  object(input, 'Request');
  const target = resolveTarget(input.target);
  const options = input.options === undefined ? {} : object(input.options, 'Options');
  let path;
  switch (input.operation) {
    case 'conversations':
      if (!target.projectScoped) invalid('List conversations requires a Foundry project endpoint. Choose account + project or paste a project endpoint.');
      path = 'conversations';
      break;
    case 'conversation':
    case 'conversation-items':
      path = `conversations/${identifier(input.conversationId, 'Conversation ID')}${input.operation === 'conversation-items' ? '/items' : ''}`;
      break;
    case 'response':
    case 'input-items':
      path = `responses/${identifier(input.responseId, 'Response ID')}${input.operation === 'input-items' ? '/input_items' : ''}`;
      break;
    default:
      invalid('Choose a supported conversation or response read operation.');
  }
  const url = new URL(path, target.baseUrl);
  if (options.apiVersion) {
    if (target.projectScoped) invalid('Project endpoints use the v1 route without an api-version query parameter.');
    if (!['v1', 'preview'].includes(options.apiVersion)) invalid('API version must be v1 or preview.');
    url.searchParams.set('api-version', options.apiVersion);
  }
  if (input.operation === 'response') {
    if (options.include !== undefined) {
      if (!Array.isArray(options.include) || options.include.length > 20) invalid('Include must be an array of at most 20 field names.');
      for (const field of options.include) {
        const name = text(field, 'Include field', 128);
        if (!/^[A-Za-z0-9_.]+$/.test(name)) invalid('Include field names may contain letters, numbers, underscores and dots.');
        url.searchParams.append('include[]', name);
      }
    }
  } else if (listOperations.has(input.operation)) {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('Page size must be an integer from 1 to 100.');
    const order = options.order ?? 'desc';
    if (!['asc', 'desc'].includes(order)) invalid('Order must be asc or desc.');
    if (options.after && options.before) invalid('Use either After or Before, not both.');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('order', order);
    for (const cursor of ['after', 'before']) {
      if (options[cursor]) url.searchParams.set(cursor, identifier(options[cursor], `${cursor} cursor`));
    }
  }
  const auth = object(input.auth, 'Authentication');
  if (!['cli', 'key'].includes(auth.mode)) invalid('Choose Azure CLI or API key authentication.');
  if (target.projectScoped && auth.mode !== 'cli') invalid('Foundry project endpoints require Microsoft Entra ID. Choose Azure CLI authentication.');
  const audience = auth.audience || 'https://ai.azure.com';
  if (!audiences.has(audience)) invalid('Select a supported Microsoft Entra token audience.');
  if (target.projectScoped && audience !== 'https://ai.azure.com') invalid('Project endpoints require the https://ai.azure.com audience.');
  const tenant = text(auth.tenant ?? '', 'Tenant', 256);
  if (tenant && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(tenant)) invalid('Tenant must be a tenant ID or tenant domain.');
  return { url: url.href, operation: input.operation, auth: { ...auth, audience, tenant } };
}

export async function acquireCliToken({ audience, tenant }, runner = execFileAsync) {
  const args = ['account', 'get-access-token', '--resource', audience, '--query', 'accessToken', '--output', 'tsv', '--only-show-errors'];
  if (tenant) args.push('--tenant', tenant);
  // Windows launches Azure CLI through az.cmd. All command arguments above are fixed or validated.
  const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'az';
  const launchArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `az ${args.join(' ')}`] : args;
  let stdout;
  try {
    ({ stdout } = await runner(executable, launchArgs, { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }));
  } catch (error) {
    const reason = typeof error.stderr === 'string' ? error.stderr.trim().slice(0, 1200) : '';
    throw new LabError(401, 'azure_cli_authentication_failed',
      `Could not obtain an Azure CLI token. Install Azure CLI and run az login for the correct tenant.${reason ? ` ${reason}` : ''}`);
  }
  const token = stdout.trim();
  if (!token || /\s/.test(token)) throw new LabError(401, 'empty_token', 'Azure CLI did not return a valid access token. Run az login again.');
  return token;
}

function redact(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

async function readUpstream(response) {
  const maximum = 16 * 1024 * 1024;
  const parts = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > maximum) throw new LabError(502, 'response_too_large', 'Azure returned more than 16 MiB. Reduce the page size or the included fields.');
    parts.push(Buffer.from(part));
  }
  const raw = Buffer.concat(parts).toString('utf8');
  if (!raw) throw new LabError(502, 'empty_upstream_response', 'Azure returned an empty response.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new LabError(502, 'invalid_upstream_json', `Azure returned non-JSON data (HTTP ${response.status}). Verify your endpoint and network/proxy settings.`);
  }
}

export async function executeRequest(input, { fetchImpl = fetch, tokenProvider = acquireCliToken, env = process.env } = {}) {
  const request = prepareRequest(input);
  let secret;
  if (request.auth.mode === 'key') {
    secret = text(request.auth.apiKey || env.AZURE_OPENAI_API_KEY || '', 'API key', 4096);
    if (!secret) invalid('Enter an API key or configure AZURE_OPENAI_API_KEY in the server environment.');
    if (/[\x00-\x20\x7f]/.test(secret)) invalid('API key must not contain whitespace or control characters.');
  } else {
    const tenant = request.auth.tenant || env.AZURE_TENANT_ID || '';
    if (tenant && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(tenant)) invalid('AZURE_TENANT_ID must be a tenant ID or tenant domain.');
    secret = await tokenProvider({ audience: request.auth.audience, tenant });
  }
  const headers = { Accept: 'application/json' };
  if (request.auth.mode === 'key') headers['api-key'] = secret;
  else headers.Authorization = `Bearer ${secret}`;
  const metadata = { method: 'GET', url: request.url, authentication: request.auth.mode === 'key' ? 'api-key (redacted)' : `Bearer (redacted); audience ${request.auth.audience}` };
  const started = Date.now();
  let response;
  let data;
  try {
    response = await fetchImpl(request.url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
    data = redact(await readUpstream(response), secret);
  } catch (error) {
    if (error instanceof LabError) throw new LabError(error.status, error.code, error.message, { request: metadata });
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new LabError(timedOut ? 504 : 502, timedOut ? 'azure_timeout' : 'azure_connection_failed',
      timedOut ? 'Azure did not finish within 60 seconds.' : 'Could not reach Azure. Check the endpoint, DNS, firewall, private endpoint access and proxy settings.',
      { request: metadata });
  }
  const result = {
    request: metadata,
    status: response.status,
    elapsedMs: Date.now() - started,
    requestId: response.headers.get('apim-request-id') || response.headers.get('x-request-id'),
    retryAfter: response.headers.get('retry-after'),
    data
  };
  if (!response.ok) {
    const message = typeof data?.error?.message === 'string' ? data.error.message
      : typeof data?.message === 'string' ? data.message : `Azure returned HTTP ${response.status}.`;
    const hints = {
      401: 'Check the key or sign in again; verify the selected token audience and tenant.',
      403: 'Check data-plane RBAC, project access and the resource network/firewall configuration.',
      404: request.operation.startsWith('conversation')
        ? 'Verify the project/account endpoint and conversation ID (when used). The conversation may have been deleted, or this route may not be available in the selected scope.'
        : 'Verify the response ID and the exact account/project where it was created. Deleted, expired or unstored responses cannot be retrieved.',
      429: 'Azure throttled the request. Wait for Retry-After before retrying.'
    };
    throw new LabError(response.status, 'azure_api_error', message, { ...result, hint: hints[response.status] || 'Inspect the Azure error body and request ID.' });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || (request.operation === 'response' && (typeof data.id !== 'string' || data.object !== 'response'))
      || (request.operation === 'conversation' && (typeof data.id !== 'string' || data.object !== 'conversation'))
      || (listOperations.has(request.operation) && (!Array.isArray(data.data) || typeof data.has_more !== 'boolean'))
      || (request.operation === 'conversations' && data.data.some(item => !item || typeof item.id !== 'string' || !identifierPattern.test(item.id)))) {
    throw new LabError(502, 'unexpected_response_shape', 'Azure returned JSON that does not match the selected REST operation.', result);
  }
  return result;
}
