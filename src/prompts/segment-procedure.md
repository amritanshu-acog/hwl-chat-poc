You are extracting from a specific section of a PDF document.

SECTION HEADING: {{HEADING}}
SECTION PAGES: {{PAGES}}

SECTION TEXT:
{{CONTENT}}

---

Extract the knowledge in this section only. Produce a SINGLE chunk JSON object (not an array).
Required fields: chunk_id, topic, summary, triggers, has_conditions, escalation, related_chunks, status, context, response, escalation_detail.
Return ONLY valid JSON. No markdown fences. No explanation.
