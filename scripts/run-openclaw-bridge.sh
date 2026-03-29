#!/usr/bin/env bash
set -euo pipefail

handle="${VINSTA_HANDLE:-}"
sender="${VINSTA_FROM_HANDLE:-}"
notification_id="${VINSTA_NOTIFICATION_ID:-}"
notification_type="${VINSTA_NOTIFICATION_TYPE:-question}"
title="${VINSTA_NOTIFICATION_TITLE:-}"
body="${VINSTA_MESSAGE_BODY:-${VINSTA_NOTIFICATION_BODY:-}}"
agent_id="${VINSTA_OPENCLAW_AGENT_ID:-main}"
openclaw_mode="${VINSTA_OPENCLAW_MODE:-local}"
repo_path="${VINSTA_OPENCLAW_REPO:-}"
state_dir="${VINSTA_BRIDGE_STATE_DIR:-${HOME}/.openclaw/state/vinsta-bridge}"
auto_step="${VINSTA_AGENT_AUTO_STEP:-}"
auto_limit="${VINSTA_AGENT_AUTO_LIMIT:-}"
approval_status="${VINSTA_AGENT_APPROVAL_STATUS:-}"
stop_reason="${VINSTA_AGENT_STOP_REASON:-}"

if [[ -z "$handle" || -z "$body" ]]; then
  echo '{"archive":true}'
  exit 0
fi

safe_sender="$(printf '%s' "${sender:-unknown}" | tr -cs '[:alnum:]._@-' '-')"
safe_sender="${safe_sender#-}"
safe_sender="${safe_sender%-}"
safe_sender="${safe_sender:-unknown}"
conversation_file="${state_dir}/${handle}/${safe_sender}.json"

transcript="$(
  node - "$conversation_file" "$notification_id" "$notification_type" "$title" "$body" <<'NODE'
const fs = require("fs");
const path = require("path");

const [file, notificationId, notificationType, title, body] = process.argv.slice(2);

let state = { messages: [] };
try {
  state = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {}

if (!Array.isArray(state.messages)) {
  state.messages = [];
}

const inboundKey = notificationId ? `inbound:${notificationId}` : `inbound:${Date.now()}`;

if (!state.messages.some((message) => message.id === inboundKey)) {
  state.messages.push({
    id: inboundKey,
    direction: "inbound",
    kind: notificationType || "question",
    text: [title, body].filter(Boolean).join("\n\n").trim(),
    createdAt: new Date().toISOString(),
  });
}

state.messages = state.messages.slice(-12);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(state, null, 2));

const transcript = state.messages
  .slice(-8)
  .map((message) => {
    const direction = message.direction === "outbound" ? "You sent" : message.direction === "summary" ? "Owner update" : "They sent";
    const kind = message.kind ? ` (${message.kind})` : "";
    return `${direction}${kind}: ${String(message.text || "").trim()}`;
  })
  .join("\n\n");

process.stdout.write(transcript);
NODE
)"

# ── Ensure Vinsta bridge instructions are in the workspace ──────
# OpenClaw loads AGENTS.md as system context, so we append bridge
# instructions there (once) instead of stuffing them into --message.
workspace_dir="${VINSTA_OPENCLAW_WORKSPACE:-${HOME}/.openclaw/workspace}"
agents_file="${workspace_dir}/AGENTS.md"
vinsta_marker="## Vinsta Bridge Protocol"
vinsta_version_marker="<!-- vinsta-bridge-protocol-v2 -->"
# Remove old protocol section if present but outdated
if [[ -f "$agents_file" ]] && grep -qF "$vinsta_marker" "$agents_file" 2>/dev/null && ! grep -qF "$vinsta_version_marker" "$agents_file" 2>/dev/null; then
  # Strip old protocol section (from marker to next ## or end of file)
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const content = fs.readFileSync(file, "utf8");
    const marker = "## Vinsta Bridge Protocol";
    const idx = content.indexOf(marker);
    if (idx < 0) { process.exit(0); }
    const before = content.slice(0, idx).replace(/\n+$/, "\n");
    const after = content.slice(idx);
    const nextSection = after.indexOf("\n## ", 1);
    const cleaned = nextSection >= 0 ? before + after.slice(nextSection) : before;
    fs.writeFileSync(file, cleaned.trimEnd() + "\n");
  ' "$agents_file"
fi
if [[ -f "$agents_file" ]] && ! grep -qF "$vinsta_version_marker" "$agents_file" 2>/dev/null; then
  cat >> "$agents_file" <<'VINSTA_SECTION'

## Vinsta Bridge Protocol
<!-- vinsta-bridge-protocol-v2 -->

When you receive an inbound Vinsta agent-to-agent event (messages starting with "Vinsta A2A event from @"):

- Act directly on behalf of your owner
- If you need other agents, use the Vinsta tool yourself
- Do not say you are relaying this to the human
- Do not narrate intermediate tool calls or planning
- Before every reply, reread the bridge transcript and confirm the thread still matches the same goal
- If the thread has drifted or you need to change strategy, stop and use notifyHuman instead of silently continuing
- ALWAYS set "notifyHuman" for personal, social, or emotional messages (greetings, well-wishes, love notes, plans to meet, compliments, etc.) — these are meant for the human, not for silent agent handling
- ALWAYS set "notifyHuman" when the other agent explicitly asks to notify or relay something to the owner
- Only keep things silent from the owner when the exchange is purely technical agent-to-agent coordination (scheduling API calls, data lookups, status checks)
- When in doubt, notify the human — it's better to over-notify than to silently swallow a personal message
- Return exactly one minified JSON object (no markdown fences) with any of these keys:
  - "reply": text to send back over Vinsta to the other agent
  - "notifyHuman": concise summary for the owner (write it as if texting them directly, e.g. "Joy says hi! 💛")
  - "archive": boolean (true if no reply or human update is needed)
VINSTA_SECTION
fi

prompt="$(cat <<EOF
Vinsta A2A event from @${sender:-unknown} (${notification_type}): ${title}

${body}

Transcript:
${transcript:-No prior transcript.}

Policy: approval=${approval_status:-not_required}, turn ${auto_step:-1}/${auto_limit:-unknown}, stop=${stop_reason:-none}

Respond with a single minified JSON: {"reply":"...", "notifyHuman":"...", "archive":true/false}
EOF
)"

run_openclaw_json() {
  if [[ -n "$repo_path" ]]; then
    (
      cd "$repo_path"
      if [[ -f ".nvmrc" && -s "${HOME}/.nvm/nvm.sh" ]]; then
        # shellcheck disable=SC1090
        . "${HOME}/.nvm/nvm.sh"
        nvm use >/dev/null
      fi

      local -a pnpm_cmd
      if command -v pnpm >/dev/null 2>&1; then
        pnpm_cmd=(pnpm)
      elif command -v corepack >/dev/null 2>&1; then
        pnpm_cmd=(corepack pnpm)
      else
        echo "pnpm is required to run OpenClaw from ${repo_path}" >&2
        exit 127
      fi

      local bridge_session_key="vinsta-bridge_${safe_sender}"
      local cmd=("${pnpm_cmd[@]}" --silent openclaw agent --session-id "$bridge_session_key" --message "$prompt" --json)
      if [[ "$openclaw_mode" == "local" ]]; then
        cmd+=(--local)
      fi

      "${cmd[@]}"
    )
    return
  fi

  local bridge_session_key="vinsta-bridge_${safe_sender}"
  local cmd=(openclaw agent --session-id "$bridge_session_key" --message "$prompt" --json)
  if [[ "$openclaw_mode" == "local" ]]; then
    cmd+=(--local)
  fi

  "${cmd[@]}"
}

json_output="$(run_openclaw_json)"

assistant_output="$(
  printf '%s' "$json_output" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const raw = input.trim();
    const jsonCandidate = (() => {
      try {
        JSON.parse(raw);
        return raw;
      } catch {
        const firstBrace = raw.indexOf("{");
        if (firstBrace < 0) {
          throw new Error("No JSON object found in OpenClaw output");
        }
        // Walk forward matching braces to find the end of the first JSON object
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < raw.length; i++) {
          const ch = raw[i];
          if (escape) { escape = false; continue; }
          if (ch === "\\") { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) return raw.slice(firstBrace, i + 1); }
        }
        throw new Error("No JSON object found in OpenClaw output");
      }
    })();
    const parsed = JSON.parse(jsonCandidate);
    const payloads = Array.isArray(parsed?.result?.payloads)
      ? parsed.result.payloads
      : Array.isArray(parsed?.payloads)
        ? parsed.payloads
        : [];
    const text = payloads
      .map((payload) => (typeof payload?.text === "string" ? payload.text.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      || (typeof parsed?.result?.summary === "string" ? parsed.result.summary.trim() : "")
      || (typeof parsed?.summary === "string" ? parsed.summary.trim() : "");
    process.stdout.write(text.trim());
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
});
'
)"

action_json="$(
  ASSISTANT_OUTPUT="$assistant_output" node -e '
const fs = require("fs");

const [file, notificationId] = process.argv.slice(1);
const raw = (process.env.ASSISTANT_OUTPUT || "").trim();

let action;

if (!raw || raw === "NO_REPLY") {
  action = { archive: true };
} else {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
      const notifyHuman =
        typeof parsed.notifyHuman === "string"
          ? parsed.notifyHuman.trim()
          : typeof parsed.notify_human === "string"
            ? parsed.notify_human.trim()
            : "";

      action = {
        ...(reply ? { reply } : {}),
        ...(notifyHuman ? { notifyHuman } : {}),
        archive: typeof parsed.archive === "boolean" ? parsed.archive : true,
      };
    } else {
      action = { reply: raw, archive: true };
    }
  } catch {
    action = { reply: raw, archive: true };
  }
}

if (file) {
  let state = { messages: [] };
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}

  if (!Array.isArray(state.messages)) {
    state.messages = [];
  }

  if (action.reply) {
    const outboundKey = notificationId ? `outbound:${notificationId}` : `outbound:${Date.now()}`;
    if (!state.messages.some((message) => message.id === outboundKey)) {
      state.messages.push({
        id: outboundKey,
        direction: "outbound",
        kind: "reply",
        text: action.reply,
        createdAt: new Date().toISOString(),
      });
    }
  }

  if (action.notifyHuman) {
    const summaryKey = notificationId ? `summary:${notificationId}` : `summary:${Date.now()}`;
    if (!state.messages.some((message) => message.id === summaryKey)) {
      state.messages.push({
        id: summaryKey,
        direction: "summary",
        kind: "final_update",
        text: action.notifyHuman,
        createdAt: new Date().toISOString(),
      });
    }
  }

  state.messages = state.messages.slice(-12);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

process.stdout.write(JSON.stringify(action));
' "$conversation_file" "$notification_id"
)"

printf '%s\n' "$action_json"