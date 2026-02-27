You are extracting Q&A pairs/FAQs from a specific section of a PDF.

SECTION HEADING: {{HEADING}}
SECTION PAGES: {{PAGES}}

SECTION TEXT:
{{CONTENT}}

---

Extract ONLY valid Questions and Answers found in this section.
Required fields for each Q&A chunk: chunk_id, topic, summary, triggers (the question), has_conditions, escalation, related_chunks, status, context, response (the answer).
Return ONLY a raw JSON array. Start with [ and end with ]. No markdown fences.
