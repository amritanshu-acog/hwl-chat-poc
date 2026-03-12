import { runChunk } from "./chunk.js";

const arg = process.argv[2];
const docTypes: ("procedure" | "qna")[] =
  arg === "procedure" || arg === "qna" ? [arg] : ["procedure", "qna"];

for (const doc_type of docTypes) {
  await runChunk(doc_type);
}
