# Foundry Conversation Explorer

[![CI](https://github.com/mobaniha/foundry-conversation-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/mobaniha/foundry-conversation-explorer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A dependency-free, local browser lab using **read-only REST APIs**.
The primary workflow is **List conversations -> Select conversation -> Read its items**.

Browse Microsoft Foundry conversations by account and project, inspect messages
and tool activity, and retrieve stored Azure OpenAI responses without invoking
a model or changing Azure resources.

## Features

- Discover project conversations or open a known conversation ID directly.
- Read paginated message/tool history in chronological order.
- Inspect conversation metadata, raw JSON, Azure request IDs and errors.
- Export the current page as JSON and return to the cached conversation list.
- Keep the original Get response and List input items tools.
- Authenticate through Azure CLI, or use account API keys where supported.
- Run locally with Node built-ins only: no dependencies, build step or Azure
  infrastructure deployment.

The UI retains its **Conversations & Responses Lab** title. This is a community
development lab, not an official Microsoft product or a production hosted
service. It requires a local Node backend; GitHub Pages alone cannot run it.

## Conversation REST operations

For Foundry projects, use this base URL:

```text
https://ACCOUNT.services.ai.azure.com/api/projects/PROJECT/openai/v1
```

| Operation | REST path relative to the base URL |
| --- | --- |
| List conversations | `GET /conversations` |
| Get conversation metadata | `GET /conversations/CONVERSATION_ID` |
| List conversation items | `GET /conversations/CONVERSATION_ID/items` |

Conversation discovery requires a **Foundry project**. You can also retrieve a
known conversation and its items at a supported account endpoint; listing all
account conversations is not exposed by this lab. A `conv_...` conversation ID
is a history container, not a `resp_...` response ID. Conversation items include
user messages, assistant messages, and tool activity. Item IDs must not be used
as response IDs.

The original response operations remain available:

| Operation | Account URL |
| --- | --- |
| Get response | `GET https://ACCOUNT.openai.azure.com/openai/v1/responses/RESPONSE_ID` |
| List input items | `GET https://ACCOUNT.openai.azure.com/openai/v1/responses/RESPONSE_ID/input_items` |

Foundry projects use the same paths under
`https://ACCOUNT.services.ai.azure.com/api/projects/PROJECT/openai/v1/`.
Project scope is part of the URL, not an `OpenAI-Project` header. Account and
project storage scopes are not interchangeable. This targets current Foundry
projects under a Foundry resource, not legacy hub-based project endpoints.

## Prerequisites

- [Node.js](https://nodejs.org/) 22.9 or newer and, for keyless authentication,
  [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli).
- An existing Azure OpenAI account or Foundry resource/project.
- To browse conversations, only your account/project is needed; no response ID is
  required. To open history directly, use the conversation ID shown in Foundry.
- Only for the original response operations: an existing **response ID** in that
  scope. Responses cannot be enumerated. The response must have been stored
  (`store: true`, normally the default), not deleted or expired. Default response
  retention is normally 30 days; this is not a conversation retention rule.
- Network access to the Azure endpoint, including private endpoint DNS/VPN if
  applicable, and data-plane permissions. For account endpoints, an appropriate
  role is **Cognitive Services OpenAI User**; project endpoints also require
  appropriate Foundry project access (for example **Azure AI User**).
  Subscription/resource Reader or Contributor alone does not imply inference
  data access.

No Azure resources are created or changed. There is intentionally no create,
delete, model invocation, response enumeration, or streaming feature.

## Start (PowerShell)

```powershell
git clone https://github.com/mobaniha/foundry-conversation-explorer.git
Set-Location foundry-conversation-explorer
az login
npm start
```

Open **http://127.0.0.1:3000**. No `npm install` is needed; only Node built-ins
are used. Stop with Ctrl+C.

On macOS/Linux, use `cd foundry-conversation-explorer` instead of `Set-Location`.
The npm commands are the same.

For a specific tenant, sign in with `az login --tenant YOUR_TENANT_ID`; optionally
enter that tenant in the UI. The UI never initiates an interactive sign-in.

### Optional API key / port configuration

```powershell
Copy-Item .env.example .env
notepad .env
npm start
```

Set `AZURE_OPENAI_API_KEY` in the local `.env`, or enter an account key in the
password field. A nonempty UI key overrides the environment key. Keys are not
supported for project endpoints. `.env` is ignored by git and never served.
`PORT` defaults to `3000`; `AZURE_TENANT_ID` can select the CLI tenant.
The server binds only to `127.0.0.1`; do not expose it through a public proxy.

## Walk through the lab

1. Select **Azure OpenAI account**, **Foundry account + project**, or **Paste an
   endpoint**. Names must be resource/project names, not subscription IDs.
   For pasted endpoints, resource roots, `/openai/v1`, project roots, and project
   `/openai/v1` URLs are accepted. Only public Azure hostnames are supported,
   including `openai.azure.com`, `services.ai.azure.com`, and
   `cognitiveservices.azure.com`; sovereign clouds/custom gateways are out of scope.
2. Select **Microsoft Entra ID via Azure CLI**, or an account **API key**.
   The backend calls `az account get-access-token` for each request and sends
   the bearer token directly to Azure. No token reaches the browser.
   The current v1 examples use the `https://ai.azure.com` audience. The account
   REST reference also documents `https://cognitiveservices.azure.com`, which is
   selectable for account endpoints. Project endpoints require `https://ai.azure.com`.
3. **Foundry account + project** and **List conversations** are selected by default.
   Enter your names and click **List conversations**. The result shows selectable
   conversation IDs, their metadata and the complete Azure JSON.
4. Click **Read items** on a conversation. The lab selects that ID and retrieves
   its messages/tool activity in ascending (oldest-first) order, with fresh
   pagination cursors. **Back to conversations** restores the previously fetched
   list page and its original page size, order and cursors without another Azure
   request. Changing form settings clears that cached page.
5. If you already have the ID from Foundry, choose **List conversation items** and
   paste it directly. Choose **Get conversation metadata** to read the container's
   creation time and metadata rather than its messages. Neither requires a
   response ID.
6. All list operations have page sizes from **1 to 100** (default 20), order, and
   optional **After** or **Before** cursors (not both). **Next page** uses
   `has_more` and `last_id` (or the final returned object's ID) as the next `after`
   cursor. Each page replaces the displayed page. To move backward manually,
   use a `before` cursor; raw JSON preserves all returned IDs.
7. For the original response tools, choose **Get response** and paste a stored
   `resp_...` ID to inspect generated output, status, model and token usage.
   Optional comma-separated include fields become repeated `include[]`
   parameters. **List input items** reads that response's input context, not all
   messages in its conversation.
8. **Download JSON** explicitly saves the current Azure response body. Settings,
   credentials and results are otherwise not persisted. Changing request settings
   invalidates the displayed result and next-page cursor. Changing the target,
   operation or conversation/response ID also clears the After/Before fields so
   cursors from another scope cannot leak into a new request.

Account calls can omit `api-version` (the default v1 route), or explicitly send
`v1` / `preview`. Project calls omit that query parameter. JSON retrieval is
deliberate: streaming-only options are not exposed.

## Call the conversation REST APIs directly (PowerShell)

The browser lab uses these same GET requests. For an independent REST check:

```powershell
az login
$base = 'https://YOUR_ACCOUNT.services.ai.azure.com/api/projects/YOUR_PROJECT/openai/v1'
$token = az account get-access-token --resource https://ai.azure.com --query accessToken --output tsv
if ($LASTEXITCODE -ne 0) { throw 'Azure CLI token acquisition failed.' }
$headers = @{ Authorization = "Bearer $token" }

# List a page of conversations (no conversation ID needed).
$page = Invoke-RestMethod -Method Get -Uri "$base/conversations?limit=20&order=desc" -Headers $headers
$page.data | Select-Object id, created_at, metadata

# Use an ID from the page above or from Foundry.
$conversationId = 'conv_YOUR_CONVERSATION_ID'
$items = Invoke-RestMethod -Method Get -Uri "$base/conversations/$conversationId/items?limit=100&order=asc" -Headers $headers
$items.data | ConvertTo-Json -Depth 30
```

For another page, use `after` with the returned `last_id` while `has_more` is true.
These requests do not create a conversation or invoke a model.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| CLI authentication failure / 401 | Azure CLI installed and on PATH; `az login`; correct tenant, token audience or account key. |
| 403 | Data-plane RBAC, Foundry project access, firewall, network rules and private endpoint connectivity. |
| 404 | Exact account/project and conversation/response ID; deleted conversation, unavailable route, or missing stored response. Account and project scope can differ. |
| 429 | Azure rate limits and the displayed `Retry-After`; retry manually. |
| Connection failure | Endpoint spelling, DNS, VPN and firewall. Node's proxy behavior depends on your runtime/network configuration. |
| Non-JSON / wrong-shaped result | Use a supported data-plane endpoint, not the portal, management API, or a streaming gateway. |
| Address already in use | Set a different `PORT` in `.env`, restart and open that port. |

Azure HTTP errors, request IDs, response bodies and `Retry-After` are surfaced
without automatic retries. Local calls are limited to 32 KiB and Azure replies
to 16 MiB, with a 30-second CLI timeout and a 60-second Azure timeout.

## Credential and content handling

- No external packages/scripts, telemetry, browser storage, or credential files
  are generated. A typed API key remains in the password field until cleared or
  the page is closed; **Clear results** also clears that field.
- Only the loopback backend forwards credentials. Target URLs are restricted to
  validated HTTPS Azure account hosts and the expected API paths; redirects are
  rejected. Cross-origin API requests are rejected and responses use `no-store`.
- Azure data is rendered as text, not HTML. The exact credential used for the call
  is redacted if echoed in an Azure JSON value. Arbitrary conversation content is
  otherwise preserved; this is not a general PII/secrets scrubber.
- Downloaded JSON can contain sensitive input/output. Handle it accordingly.
  On shared machines, other local processes/users may have access to your CLI
  session; this is a single-user development lab, not a hosted service.

## Validate

```powershell
npm run check
npm test
```

Tests use injected Azure HTTP responses and token providers; they never consume
Azure resources or require credentials. Real-account verification requires your
target, an existing conversation/response (or a project containing conversations),
identity/key and network access. Browser workflow checks use test-only mocked
Azure results, not sample data in the application.

GitHub Actions runs syntax checks and the test suite on Windows and Ubuntu with
Node.js 22 and 24. CI needs no Azure credentials or secrets.

## Project layout

| File | Purpose |
| --- | --- |
| [index.html](index.html) | Self-contained browser UI with light/dark themes. |
| [server.mjs](server.mjs) | Loopback HTTP server, browser request boundary and static page delivery. |
| [lab.mjs](lab.mjs) | Validated REST URLs, authentication and Azure GET requests. |
| [lab.test.mjs](lab.test.mjs) | API contract and HTTP integration tests with synthetic fixtures. |
| [.env.example](.env.example) | Optional local configuration template; contains no credentials. |

## Contributing

Keep changes read-only and dependency-free where possible, and run both
validation commands before opening a pull request. Never include API keys,
tokens, tenant details or real conversation content in commits, issues or logs.
Local environment files and exported `foundry-*.json` data are ignored by git.

## License

[MIT](LICENSE).

## Official references

- [Foundry project Conversations REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/aiproject#conversations)
- [Account Conversations REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/conversations)
- [How conversations and responses relate](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/runtime-components)
- [Account Get response](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses#get-response)
- [Account List input items](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses#list-input-items)
- [Foundry project Responses reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/aiproject#responses)
- [Responses guide: retrieval, input items and retention](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses)
- [Project endpoint and Entra audience setup](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-chat-reasoning)
