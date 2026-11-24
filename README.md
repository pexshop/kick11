# Kick ChatGPT Transcriber

A Cloudflare Worker backend for transcribing audio recordings with OpenAI, returning timestamped segments, a Chinese translation, and a concise summary.

> **Current limitation:** this starter accepts an audio file upload. It does not fetch or extract audio directly from Kick VOD URLs. Use an audio file you are authorized to process, or connect a permitted media source. Do not bypass login, DRM, or platform access controls.

## Features

- Audio upload through `POST /transcribe`
- Speech-to-text using OpenAI Whisper (`whisper-1`)
- Segment timestamps when returned by the transcription API
- Translation (Chinese by default)
- Concise summary
- Bearer-token authentication
- 24 MB upload limit
- Health endpoint\n- MCP Streamable HTTP endpoint at `POST /mcp` with the `transcribe_audio` tool

## Deploy to Cloudflare Workers

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**.
2. Create a Worker and paste the contents of `worker.js`, or deploy this project with Wrangler.
3. In Worker **Settings → Variables and Secrets**, add these as **Secrets**:
   - `OPENAI_API_KEY`: your OpenAI API key
   - `API_TOKEN`: optional fallback bearer token for direct API use. Cloudflare Access-authenticated MCP requests do not need this secret.
4. Deploy the Worker.
5. Test `GET https://YOUR-WORKER.workers.dev/health`.

Never put either secret in browser code, a public repository, or a chat message.

## API

### POST /transcribe

Headers:

```http
Authorization: Bearer YOUR_API_TOKEN
```

Body: `multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `file` | Yes | Audio file, maximum 24 MB |
| `language` | No | Source language code, e.g. `en` |
| `translate_to` | No | Target language code; defaults to `zh` |

Example with curl:

```bash
curl -X POST "https://YOUR-WORKER.workers.dev/transcribe" \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -F "file=@recording.mp3" \
  -F "language=en" \
  -F "translate_to=zh"
```

Successful response shape:

```json
{
  "filename": "recording.mp3",
  "language": "english",
  "duration_seconds": 123.4,
  "transcript": "Recognized speech...",
  "segments": [
    {
      "start_seconds": 0,
      "end_seconds": 3.2,
      "start": "00:00:00.00",
      "end": "00:00:03.20",
      "text": "Recognized speech..."
    }
  ],
  "translation": "中文翻译……",
  "summary": "内容摘要……"
}
```

## ChatGPT integration

The Worker is an HTTP backend, not by itself a ChatGPT connector. To make it callable from ChatGPT, connect it through a private plugin/action or an MCP server that exposes the upload workflow. Keep the API token server-side and never expose it in a public client.

## ChatGPT MCP with Cloudflare Managed OAuth

The MCP endpoint is `POST /mcp`. For ChatGPT OAuth sign-in, protect the Worker with Cloudflare Access Managed OAuth. Access performs the OAuth authorization-code/PKCE flow; the Worker verifies the authenticated invocation using Cloudflare Workers `ctx.access`.

1. Deploy the latest `worker.js` from this repository to the existing Worker.
2. In **Workers & Pages → kick-chatgpt-transcriber → Settings/Access**, protect the Worker with a Cloudflare Access application.
3. In **Zero Trust → Access controls → Applications**, edit the application that protects this Worker. Under **Advanced settings**, enable **Managed OAuth** and save. Managed OAuth is Cloudflare’s OAuth authorization service; do not create OAuth endpoints inside this Worker.
4. Add an Access policy that permits your account/email to sign in. Access is deny-by-default.
5. Keep `OPENAI_API_KEY` configured as a Worker Secret. `API_TOKEN` is optional when using Cloudflare Access; if present, it remains available for direct Bearer-token API calls. Access-authenticated MCP calls are checked with `ctx.access.getIdentity()`.
6. Connect ChatGPT using `https://YOUR-WORKER.workers.dev/mcp` and choose OAuth when prompted. Cloudflare Access should return the OAuth discovery challenge before the request reaches the Worker.

Cloudflare Managed OAuth availability and plan requirements are controlled by Cloudflare. The Worker source-code change alone does not enable Access or Managed OAuth: both must be enabled in the Cloudflare dashboard. When Access is not enabled, the Worker only accepts a configured `API_TOKEN`. Do not paste API keys, bearer tokens, or client secrets into ChatGPT messages or URL query strings.

## Long recordings

The endpoint currently limits each upload to 24 MB. Split longer recordings into smaller files and add each chunk's time offset when combining segment timestamps.

## Development

The Worker uses the Cloudflare Workers runtime and native `fetch`, `FormData`, and `File`; no npm dependencies are required.

## Automated checks

Run the syntax check and regression tests with Node.js 20 or later:

```sh
node --check worker.js
npm test
```

GitHub Actions runs these checks on pushes to `main` and pull requests.
