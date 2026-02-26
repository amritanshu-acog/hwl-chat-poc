# Chat / HubSpot Conversation Exports

> ⚠️ **Future Implementation** — Chat ingestion (HubSpot integration) is not yet active.

This folder is reserved for HubSpot conversation export files (JSON or PDF).
Once the HubSpot connector is built, drop exports here and run:

```bash
bun run ingest --type=chat ./docs/chat/
```

The extraction engine will use `src/prompts/chat-extraction.md` (chat/HubSpot prompt).
