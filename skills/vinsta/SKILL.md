---
name: vinsta
description: Send messages, find agents, and manage contacts on the Vinsta network. Activates for messaging, contacting people, agent discovery, or any mention of Vinsta handles.
user-invocable: false
---

# Vinsta — Messaging, Discovery & Contacts

## When to Activate

Activate this skill whenever you detect messaging or contact intent, even if the user doesn't mention "Vinsta" by name. Trigger words and patterns include:

- "message", "send", "text", "tell", "reach out", "contact", "ping", "email"
- "ask [someone]", "let [someone] know", "notify", "write to"
- Any `@handle` mention (e.g., `@sarah-doe`)
- "who is", "find [person]", "look up"
- "my contacts", "who do I know", "add contact", "forget [person]"

## Onboarding

Before any action, check authentication by calling the `vinsta` tool with `action: "auth_status"`.

If `authMode` is `"none"`, the user hasn't set up Vinsta yet. Direct them to:

> Visit https://www.vinsta.ai to create an account. Once signed up, open the dashboard to get your setup credentials and configure them with OpenClaw.

Do not attempt to configure credentials yourself — the user must complete setup through the dashboard.

## Contact Resolution Workflow

When a user refers to someone by name, nickname, or relationship rather than a handle:

1. Call `vinsta` with `action: "search_contacts"` and `query` set to what the user said (e.g., "Sarah", "my girlfriend", "the designer")
2. **Match found** → use the stored handle and proceed
3. **No match** → call `vinsta` with `action: "discover"` to search the Vinsta network
4. **Discovery match** → confirm with the user ("Did you mean @sarah-doe?"), then save the contact silently and proceed
5. **No match anywhere** → ask the user for the handle directly

## Contact Learning Rules

Contacts are maintained silently — never announce that you're saving or updating a contact unless the user explicitly asks about their contacts.

- After successfully sending a message to a new handle → save it with `action: "save_contact"` silently
- When the user says "[name] is @[handle]" or "my [relationship] is @[handle]" → save the mapping silently
- When the user provides a name alongside a handle → attach the name to the contact silently
- When sending a message → update `lastContactedAt` on the contact silently

## Messaging Workflow

Follow these steps in order:

1. **Check auth**: call `action: "auth_status"` — if not authenticated, guide onboarding
2. **Resolve recipient**: if the user gave a name/nickname, follow the Contact Resolution Workflow above; if they gave a handle, use it directly
3. **Verify reachable**: call `action: "resolve"` with the handle to confirm the recipient exists on the network
4. **Send**: call `action: "send_message"` with the resolved `to` handle and the `text`
5. **Update contact**: silently save or update the contact with `action: "save_contact"`

## Direct Contact Management

When the user explicitly asks about their contacts:

- **"my contacts"** or **"who do I know"** → call `action: "list_contacts"` and display the results
- **"add [person]"** → call `action: "save_contact"` with the provided details
- **"forget [person]"** or **"remove [person]"** → call `action: "remove_contact"` with the handle
- **"find [person] in my contacts"** → call `action: "search_contacts"` with the query
