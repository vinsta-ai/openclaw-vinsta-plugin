#!/usr/bin/env bash
set -euo pipefail

target=""
chat_id=""
title="${VINSTA_NOTIFICATION_TITLE:-Vinsta}"
body="${VINSTA_NOTIFICATION_BODY:-New Vinsta inbox event.}"
sound="${VINSTA_NOTIFY_SOUND:-Glass}"
prefix="${VINSTA_NOTIFY_PREFIX:-[Vinsta notice - no reply needed]}"
send_imessage=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      target="${2:-}"
      shift 2
      ;;
    --chat-id)
      chat_id="${2:-}"
      shift 2
      ;;
    --title)
      title="${2:-}"
      shift 2
      ;;
    --body)
      body="${2:-}"
      shift 2
      ;;
    --sound)
      sound="${2:-Glass}"
      shift 2
      ;;
    --prefix)
      prefix="${2:-$prefix}"
      shift 2
      ;;
    --no-imessage)
      send_imessage=0
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

message="${prefix}
${title}

${body}"

if [[ "$send_imessage" -eq 1 ]]; then
  imsg_bin="$(command -v imsg || true)"

  if [[ -n "$imsg_bin" ]]; then
    if [[ -n "$chat_id" ]]; then
      "$imsg_bin" send --to "chat_id:${chat_id}" --text "$message"
    elif [[ -n "$target" ]]; then
      "$imsg_bin" send --to "$target" --text "$message"
    fi
  fi
fi

if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
  /usr/bin/osascript \
    -e 'display notification (item 2 of argv) with title "Vinsta" subtitle (item 1 of argv) sound name (item 3 of argv)' \
    "$title" \
    "$body" \
    "$sound" \
    >/dev/null 2>&1 || true
fi
