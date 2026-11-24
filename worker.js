/**
 * Kick ChatGPT Transcriber — Cloudflare Worker
 *
 * POST /transcribe
 * multipart/form-data:
 *   file: audio file (required)
 *   language: source language code (optional, e.g. "en")
 *   translate_to: translation language (optional, defaults to "zh")
 *
 * Required Worker secrets:
 *   OPENAI_API_KEY
 *   API_TOKEN
 */

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const OPENAI_TRANSCRIPT_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "cache-control": "no-store"
    }
  });
}

function authorized(request, env, accessAuthenticated = false) {
  if (accessAuthenticated) return true;
  const expected = env.API_TOKEN;
  const supplied = request.headers.get("authorization") || "";
  return Boolean(expected && supplied === `Bearer ${expected}`);
}

function timestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, "0");
  return [h, String(m).padStart(2, "0"), s].join(":");
}

async function transcribe(request, env, accessAuthenticated = false) {
  if (!authorized(request, env, accessAuthenticated)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.OPENAI_API_KEY) {
    return json({ error: "Server is not configured. Set OPENAI_API_KEY as a Worker Secret." }, 503);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data with a file field." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: 'Missing audio file. Send it in the "file" form field.' }, 400);
  }
  if (file.size === 0) return json({ error: "The uploaded file is empty." }, 400);
  if (file.size > MAX_AUDIO_BYTES) {
    return json({ error: "Audio file exceeds the 24 MB limit. Split long recordings into smaller files." }, 413);
  }

  const language = String(form.get("language") || "").trim();
  const translateTo = String(form.get("translate_to") || "zh").trim();

  const audioForm = new FormData();
  audioForm.append("file", file, file.name || "audio-upload");
  audioForm.append("model", "whisper-1");
  audioForm.append("response_format", "verbose_json");
  audioForm.append("timestamp_granularities[]", "segment");
  if (language) audioForm.append("language", language);

  let transcriptResponse;
  try {
    transcriptResponse = await fetch(OPENAI_TRANSCRIPT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: audioForm
    });
  } catch {
    return json({ error: "Could not reach the transcription service." }, 502);
  }

  const transcriptBody = await transcriptResponse.json().catch(() => ({}));
  if (!transcriptResponse.ok) {
    return json({
      error: "Transcription request failed.",
      upstream_status: transcriptResponse.status,
      details: transcriptBody.error?.message || "OpenAI returned an error."
    }, 502);
  }

  const originalText = transcriptBody.text || "";
  const segments = (transcriptBody.segments || []).map((segment) => ({
    start_seconds: segment.start,
    end_seconds: segment.end,
    start: timestamp(segment.start),
    end: timestamp(segment.end),
    text: segment.text || ""
  }));

  let translation = "";
  let summary = "";
  if (originalText) {
    const chatResponse = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You process speech transcripts. Return valid JSON with keys translation and summary. Translate the transcript faithfully into the requested language, preserving meaning and uncertainty. Summarize the main points concisely. Do not invent missing speech or identify speakers."
          },
          {
            role: "user",
            content: `Target translation language: ${translateTo}\n\nTranscript:\n${originalText}`
          }
        ]
      })
    });

    const chatBody = await chatResponse.json().catch(() => ({}));
    if (chatResponse.ok) {
      try {
        const result = JSON.parse(chatBody.choices?.[0]?.message?.content || "{}");
        translation = result.translation || "";
        summary = result.summary || "";
      } catch {
        summary = "Translation and summary could not be parsed.";
      }
    } else {
      summary = "Transcription completed, but translation and summary failed.";
    }
  }

  return json({
    filename: file.name || null,
    language: transcriptBody.language || language || null,
    duration_seconds: transcriptBody.duration ?? null,
    transcript: originalText,
    segments,
    translation,
    summary,
    notes: [
      "Speaker identities are not inferred from voices.",
      "Unclear speech should remain marked as unclear rather than guessed.",
      "This endpoint accepts uploaded audio; it does not download Kick VOD URLs."
    ]
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400"
        }
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "Kick ChatGPT Transcriber",
        status: "ok",
        endpoints: { health: "GET /health", transcribe: "POST /transcribe", mcp: "POST /mcp" }
      }, 200, origin);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" }, 200, origin);
    }

    if (url.pathname === "/mcp" && request.method === "POST") {
      let accessAuthenticated = false;
      if (ctx?.access) {
        try {
          const identity = await ctx.access.getIdentity();
          accessAuthenticated = Boolean(identity);
        } catch {
          accessAuthenticated = false;
        }
      }
      const response = await handleMcp(request, env, accessAuthenticated);
      const headers = new Headers(response.headers);
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname === "/mcp" && request.method === "GET") {
      return json({ error: "Use POST for MCP JSON-RPC requests." }, 405, origin);
    }

    if (url.pathname === "/transcribe" && request.method === "POST") {
      const response = await transcribe(request, env);
      const headers = new Headers(response.headers);
      headers.set("access-control-allow-origin", origin);
      return new Response(response.body, { status: response.status, headers });
    }

    return json({ error: "Not found" }, 404, origin);
  }
};


/**
 * MCP Streamable HTTP endpoint
 * POST /mcp with JSON-RPC messages. Audio is supplied as base64 in the tool call.
 */
function mcpResult(id, result) {
  return json({ jsonrpc: "2.0", id, result });
}
function mcpError(id, code, message, data) {
  return json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, 200);
}
function decodeBase64(value) {
  const clean = value.replace(/^data:[^,]+,/, "").replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function handleMcp(request, env, accessAuthenticated = false) {
  if (!authorized(request, env, accessAuthenticated)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }
  if (!env.OPENAI_API_KEY) {
    return mcpError(null, -32603, "Server is not configured. Set OPENAI_API_KEY as a Worker Secret.");
  }
  let body;
  try { body = await request.json(); } catch { return mcpError(null, -32700, "Parse error"); }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return mcpError(body?.id ?? null, -32600, "Invalid Request");
  }
  const id = body.id;
  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") {
    return new Response(null, { status: 202 });
  }
  if (body.method === "initialize") {
    return mcpResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "kick-chatgpt-transcriber", version: "1.0.0" },
      instructions: "Use transcribe_audio with a base64-encoded audio file. This server does not fetch Kick VOD URLs."
    });
  }
  if (body.method === "ping") return mcpResult(id, {});
  if (body.method === "tools/list") {
    return mcpResult(id, { tools: [{
      name: "transcribe_audio",
      description: "Transcribe an audio file, return timestamped segments, translate it (Chinese by default), and summarize it. Provide the audio bytes as base64. Maximum 24 MB decoded. Does not download Kick VOD URLs.",
      inputSchema: {
        type: "object",
        properties: {
          file_base64: { type: "string", description: "Base64-encoded audio file bytes (not a URL)." },
          filename: { type: "string", description: "Filename including extension, e.g. stream.mp3." },
          mime_type: { type: "string", description: "Audio MIME type, e.g. audio/mpeg." },
          language: { type: "string", description: "Optional source language code, e.g. en." },
          translate_to: { type: "string", description: "Target language code; defaults to zh." }
        },
        required: ["file_base64", "filename"]
      }
    }] });
  }
  if (body.method === "tools/call") {
    const name = body.params?.name;
    if (name !== "transcribe_audio") {
      return mcpError(id, -32602, "Unknown tool: " + String(name));
    }
    const args = body.params?.arguments || {};
    if (typeof args.file_base64 !== "string" || typeof args.filename !== "string") {
      return mcpResult(id, { isError: true, content: [{ type: "text", text: "file_base64 and filename are required." }] });
    }
    let bytes;
    try { bytes = decodeBase64(args.file_base64); } catch {
      return mcpResult(id, { isError: true, content: [{ type: "text", text: "file_base64 is not valid base64." }] });
    }
    if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) {
      return mcpResult(id, { isError: true, content: [{ type: "text", text: "Audio must be between 1 byte and 24 MB." }] });
    }
    const form = new FormData();
    form.append("file", new File([bytes], args.filename, { type: args.mime_type || "application/octet-stream" }));
    if (args.language) form.append("language", String(args.language));
    form.append("translate_to", String(args.translate_to || "zh"));
    const internalRequest = new Request("https://internal/transcribe", {
      method: "POST",
      headers: env.API_TOKEN ? { authorization: "Bearer " + env.API_TOKEN } : {},
      body: form
    });
    const response = await transcribe(internalRequest, env, true);
    const result = await response.json();
    if (!response.ok) {
      return mcpResult(id, { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
  }
  return mcpError(id, -32601, "Method not found");
}
