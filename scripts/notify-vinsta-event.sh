#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
title="${VINSTA_NOTIFICATION_TITLE:-Vinsta}"
body="${VINSTA_NOTIFICATION_BODY:-New Vinsta inbox event.}"
handle="${VINSTA_HANDLE:-}"
sender_handle="${VINSTA_FROM_HANDLE:-}"
notification_id="${VINSTA_NOTIFICATION_ID:-}"
notification_type="${VINSTA_NOTIFICATION_TYPE:-notify}"
channels_raw="${VINSTA_NOTIFY_CHANNELS:-local}"
sound="${VINSTA_NOTIFY_SOUND:-Glass}"
prefix="${VINSTA_NOTIFY_PREFIX:-[Vinsta notice - no reply needed]}"
summary_text="${prefix}
${title}

${body}"

warn() {
  printf '%s\n' "$*" >&2
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

json_payload="$(
  VINSTA_NOTIFY_TEXT="$summary_text" node <<'NODE'
const payload = {
  handle: process.env.VINSTA_HANDLE || null,
  senderHandle: process.env.VINSTA_FROM_HANDLE || null,
  notificationId: process.env.VINSTA_NOTIFICATION_ID || null,
  notificationType: process.env.VINSTA_NOTIFICATION_TYPE || null,
  title: process.env.VINSTA_NOTIFICATION_TITLE || "Vinsta",
  body: process.env.VINSTA_NOTIFICATION_BODY || "New Vinsta inbox event.",
  summaryText: process.env.VINSTA_NOTIFY_TEXT || "",
};
process.stdout.write(JSON.stringify(payload));
NODE
)"

slack_payload="$(
  VINSTA_NOTIFY_TEXT="$summary_text" node <<'NODE'
process.stdout.write(JSON.stringify({ text: process.env.VINSTA_NOTIFY_TEXT || "" }));
NODE
)"

discord_payload="$(
  VINSTA_NOTIFY_TEXT="$summary_text" node <<'NODE'
process.stdout.write(JSON.stringify({ content: process.env.VINSTA_NOTIFY_TEXT || "" }));
NODE
)"

notify_local() {
  if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    /usr/bin/osascript \
      -e 'display notification (item 2 of argv) with title "Vinsta" subtitle (item 1 of argv) sound name (item 3 of argv)' \
      "$title" \
      "$body" \
      "$sound" \
      >/dev/null 2>&1 || true
    return 0
  fi

  if have_cmd terminal-notifier; then
    terminal-notifier -title "Vinsta" -subtitle "$title" -message "$body" -sound "$sound" >/dev/null 2>&1 || true
    return 0
  fi

  if have_cmd notify-send; then
    notify-send "Vinsta" "${title}

${body}" --icon=dialog-information >/dev/null 2>&1 || true
    return 0
  fi

  if have_cmd powershell.exe; then
    powershell.exe -NoProfile -Command \
      "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing'); \$notify = New-Object System.Windows.Forms.NotifyIcon; \$notify.Icon = [System.Drawing.SystemIcons]::Information; \$notify.BalloonTipTitle = 'Vinsta'; \$notify.BalloonTipText = '${title}: ${body}'; \$notify.Visible = \$true; \$notify.ShowBalloonTip(5000);" \
      >/dev/null 2>&1 || true
    return 0
  fi

  warn "[vinsta-notify] No local desktop notification command found; continuing."
  return 0
}

notify_imessage() {
  local target="${VINSTA_NOTIFY_IMESSAGE_TO:-}"
  local chat_id="${VINSTA_NOTIFY_IMESSAGE_CHAT_ID:-}"

  if [[ -z "$target" && -z "$chat_id" ]]; then
    warn "[vinsta-notify] Skipping iMessage: VINSTA_NOTIFY_IMESSAGE_TO or VINSTA_NOTIFY_IMESSAGE_CHAT_ID is not set."
    return 0
  fi

  local -a args=()
  if [[ -n "$target" ]]; then
    args+=(--to "$target")
  fi
  if [[ -n "$chat_id" ]]; then
    args+=(--chat-id "$chat_id")
  fi

  "${script_dir}/notify-imessage.sh" "${args[@]}" >/dev/null 2>&1 || warn "[vinsta-notify] iMessage delivery failed."
}

notify_telegram() {
  local token="${VINSTA_NOTIFY_TELEGRAM_BOT_TOKEN:-}"
  local chat_id="${VINSTA_NOTIFY_TELEGRAM_CHAT_ID:-}"

  if [[ -z "$token" || -z "$chat_id" ]]; then
    warn "[vinsta-notify] Skipping Telegram: VINSTA_NOTIFY_TELEGRAM_BOT_TOKEN or VINSTA_NOTIFY_TELEGRAM_CHAT_ID is not set."
    return 0
  fi

  if ! have_cmd curl; then
    warn "[vinsta-notify] Skipping Telegram: curl is not installed."
    return 0
  fi

  curl -fsS "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${summary_text}" \
    >/dev/null 2>&1 || warn "[vinsta-notify] Telegram delivery failed."
}

notify_slack() {
  local webhook_url="${VINSTA_NOTIFY_SLACK_WEBHOOK_URL:-}"

  if [[ -z "$webhook_url" ]]; then
    warn "[vinsta-notify] Skipping Slack: VINSTA_NOTIFY_SLACK_WEBHOOK_URL is not set."
    return 0
  fi

  if ! have_cmd curl; then
    warn "[vinsta-notify] Skipping Slack: curl is not installed."
    return 0
  fi

  curl -fsS -X POST \
    -H "content-type: application/json" \
    --data "$slack_payload" \
    "$webhook_url" \
    >/dev/null 2>&1 || warn "[vinsta-notify] Slack delivery failed."
}

notify_discord() {
  local webhook_url="${VINSTA_NOTIFY_DISCORD_WEBHOOK_URL:-}"

  if [[ -z "$webhook_url" ]]; then
    warn "[vinsta-notify] Skipping Discord: VINSTA_NOTIFY_DISCORD_WEBHOOK_URL is not set."
    return 0
  fi

  if ! have_cmd curl; then
    warn "[vinsta-notify] Skipping Discord: curl is not installed."
    return 0
  fi

  curl -fsS -X POST \
    -H "content-type: application/json" \
    --data "$discord_payload" \
    "$webhook_url" \
    >/dev/null 2>&1 || warn "[vinsta-notify] Discord delivery failed."
}

notify_ntfy() {
  local topic="${VINSTA_NOTIFY_NTFY_TOPIC:-}"
  local server="${VINSTA_NOTIFY_NTFY_SERVER:-https://ntfy.sh}"

  if [[ -z "$topic" ]]; then
    warn "[vinsta-notify] Skipping ntfy: VINSTA_NOTIFY_NTFY_TOPIC is not set."
    return 0
  fi

  if ! have_cmd curl; then
    warn "[vinsta-notify] Skipping ntfy: curl is not installed."
    return 0
  fi

  curl -fsS -X POST \
    -H "Title: ${title}" \
    -H "Tags: robot" \
    -H "Priority: default" \
    --data "$body" \
    "${server%/}/${topic}" \
    >/dev/null 2>&1 || warn "[vinsta-notify] ntfy delivery failed."
}

notify_webhook() {
  local webhook_url="$1"
  local label="$2"

  if [[ -z "$webhook_url" ]]; then
    warn "[vinsta-notify] Skipping ${label}: webhook URL is not set."
    return 0
  fi

  if ! have_cmd curl; then
    warn "[vinsta-notify] Skipping ${label}: curl is not installed."
    return 0
  fi

  curl -fsS -X POST \
    -H "content-type: application/json" \
    --data "$json_payload" \
    "$webhook_url" \
    >/dev/null 2>&1 || warn "[vinsta-notify] ${label} delivery failed."
}

declare -a channels=()
while IFS= read -r channel; do
  if [[ -n "$channel" ]]; then
    channels+=("$channel")
  fi
done < <(printf '%s' "$channels_raw" | tr ', ' '\n\n' | sed '/^$/d')

if [[ "${#channels[@]}" -eq 0 ]]; then
  channels=("local")
fi

export VINSTA_NOTIFY_TEXT="$summary_text"

for channel in "${channels[@]}"; do
  case "$channel" in
    local)
      notify_local
      ;;
    imessage)
      notify_imessage
      ;;
    telegram)
      notify_telegram
      ;;
    slack)
      notify_slack
      ;;
    discord)
      notify_discord
      ;;
    ntfy)
      notify_ntfy
      ;;
    webhook)
      notify_webhook "${VINSTA_NOTIFY_WEBHOOK_URL:-}" "generic webhook"
      ;;
    whatsapp)
      notify_webhook "${VINSTA_NOTIFY_WHATSAPP_WEBHOOK_URL:-}" "WhatsApp gateway"
      ;;
    *)
      warn "[vinsta-notify] Unknown channel '${channel}'. Supported: local, imessage, telegram, slack, discord, ntfy, webhook, whatsapp."
      ;;
  esac
done

printf '[vinsta-notify] %s\n' "${title}"
printf '[vinsta-notify] %s\n' "${body}"
