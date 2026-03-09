import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { CONFIG } from "../core/config.js";
import type { Citation } from "../core/schemas.js";

// ─── JSONL Line Types ─────────────────────────────────────────────────────────
// One JSON object per line in the session file. Fields are omitted when not
// applicable — chunk_ids and citations only appear on assistant turns from the
// respond branch.

interface SessionLine {
  type: "session";
  session_id: string;
  user_id: string;
  created_at: string;
}

interface TitleLine {
  type: "title";
  value: string;
}

export interface UserTurnLine {
  type: "turn";
  role: "user";
  window: number;
  content: string;
  ts: string;
}

export interface AssistantTurnLine {
  type: "turn";
  role: "assistant";
  window: number;
  content: string;
  chunk_ids?: string[];
  citations?: Citation[];
  duration_ms?: number;
  ts: string;
}

/** Public alias for a session turn line — use this in server/CLI code. */
export type TurnRecord = UserTurnLine | AssistantTurnLine;

type JsonlLine = SessionLine | TitleLine | TurnRecord;
type TurnLine = TurnRecord;

// ─── Public Types ─────────────────────────────────────────────────────────────

/** A single turn in the conversation window, ready to pass to an LLM call. */
export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

/** Summary of a session returned by GET /sessions. */
export interface SessionMeta {
  session_id: string;
  title: string;
  filename: string;
  updated_at: string;
  turn_count: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a Date as yyyymmdd_HHMMSS for use in filenames. */
function formatStamp(d: Date): string {
  return (
    [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("") +
    "_" +
    [
      String(d.getHours()).padStart(2, "0"),
      String(d.getMinutes()).padStart(2, "0"),
      String(d.getSeconds()).padStart(2, "0"),
    ].join("")
  );
}

function parseTurnLines(lines: JsonlLine[]): TurnLine[] {
  return lines.filter((l) => l.type === "turn") as TurnLine[];
}

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * Represents a single user session. Handles:
 *   - In-memory session state (turns, window counter, title)
 *   - JSONL persistence (full rewrite on every save)
 *   - Window management (reset after resolved question / bump on topic switch)
 *   - Quota enforcement (total user turns per session)
 */
export class Session {
  readonly session_id: string;
  readonly user_id: string;
  readonly created_at: string;
  readonly filePath: string;

  private _title: string | undefined;
  private _window: number;
  private _turns: TurnLine[];

  private constructor(opts: {
    session_id: string;
    user_id: string;
    created_at: string;
    filePath: string;
    title?: string;
    window: number;
    turns: TurnLine[];
  }) {
    this.session_id = opts.session_id;
    this.user_id = opts.user_id;
    this.created_at = opts.created_at;
    this.filePath = opts.filePath;
    this._title = opts.title;
    this._window = opts.window;
    this._turns = opts.turns;
  }

  // ─── Factory: new session ──────────────────────────────────────────────────

  /**
   * Create a fresh session for a user.
   * File path is set but the file is not written until save() is called.
   */
  static create(userId: string): Session {
    const session_id = crypto.randomUUID();
    const now = new Date();
    const filename = `${formatStamp(now)}_${session_id}.jsonl`;
    const filePath = join(CONFIG.sessions.dir, userId, filename);

    return new Session({
      session_id,
      user_id: userId,
      created_at: now.toISOString(),
      filePath,
      window: 0,
      turns: [],
    });
  }

  // ─── Factory: load from disk ───────────────────────────────────────────────

  /**
   * Load an existing session from its JSONL file.
   * Throws if the session is not found or the file is malformed.
   */
  static async load(userId: string, sessionId: string): Promise<Session> {
    const userDir = join(CONFIG.sessions.dir, userId);

    let files: string[];
    try {
      files = await readdir(userDir);
    } catch {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const filename = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    if (!filename) throw new Error(`Session not found: ${sessionId}`);

    const filePath = join(userDir, filename);
    const raw = await readFile(filePath, "utf-8");
    const lines = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as JsonlLine);

    const sessionLine = lines.find((l) => l.type === "session") as
      | SessionLine
      | undefined;
    if (!sessionLine) throw new Error(`Malformed session file: ${filename}`);

    const titleLine = lines.find((l) => l.type === "title") as
      | TitleLine
      | undefined;
    const turns = parseTurnLines(lines);

    // Current window is derived from the last recorded turn.
    const lastTurn = turns[turns.length - 1];
    const window = lastTurn ? lastTurn.window : 0;

    return new Session({
      session_id: sessionLine.session_id,
      user_id: sessionLine.user_id,
      created_at: sessionLine.created_at,
      filePath,
      title: titleLine?.value,
      window,
      turns,
    });
  }

  // ─── Factory: list sessions for a user ────────────────────────────────────

  /**
   * Return session metadata for all sessions belonging to a user.
   * Returns an empty array if the user has no sessions yet.
   * Sorted by updated_at descending (most recent first).
   */
  static async list(userId: string): Promise<SessionMeta[]> {
    const userDir = join(CONFIG.sessions.dir, userId);

    let files: string[];
    try {
      files = await readdir(userDir);
    } catch {
      return [];
    }

    const metas: SessionMeta[] = [];

    for (const filename of files.filter((f) => f.endsWith(".jsonl"))) {
      try {
        const filePath = join(userDir, filename);
        const raw = await readFile(filePath, "utf-8");
        const lines = raw
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as JsonlLine);

        const sessionLine = lines.find((l) => l.type === "session") as
          | SessionLine
          | undefined;
        if (!sessionLine) continue;

        const titleLine = lines.find((l) => l.type === "title") as
          | TitleLine
          | undefined;
        const turns = parseTurnLines(lines);
        const lastTurn = turns[turns.length - 1];

        metas.push({
          session_id: sessionLine.session_id,
          title: titleLine?.value ?? "Untitled",
          filename,
          updated_at: lastTurn?.ts ?? sessionLine.created_at,
          turn_count: turns.filter((t) => t.role === "user").length,
        });
      } catch {
        // Skip malformed files — do not crash the list endpoint.
      }
    }

    return metas.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  // ─── Getters ──────────────────────────────────────────────────────────────

  get window(): number {
    return this._window;
  }

  get title(): string | undefined {
    return this._title;
  }

  /** All turn records in chronological order — used by GET /sessions/:id and CLI --show. */
  get turns(): TurnRecord[] {
    return this._turns;
  }

  // ─── State recording ──────────────────────────────────────────────────────

  setTitle(value: string): void {
    this._title = value;
  }

  recordUserTurn(content: string): void {
    this._turns.push({
      type: "turn",
      role: "user",
      window: this._window,
      content,
      ts: new Date().toISOString(),
    });
  }

  recordAssistantTurn(
    content: string,
    opts: {
      chunk_ids?: string[];
      citations?: Citation[];
      duration_ms?: number;
    } = {},
  ): void {
    const turn: AssistantTurnLine = {
      type: "turn",
      role: "assistant",
      window: this._window,
      content,
      ts: new Date().toISOString(),
    };
    // Omit optional fields when empty to keep JSONL clean.
    if (opts.chunk_ids?.length) turn.chunk_ids = opts.chunk_ids;
    if (opts.citations?.length) turn.citations = opts.citations;
    if (opts.duration_ms !== undefined) turn.duration_ms = opts.duration_ms;

    this._turns.push(turn);
  }

  // ─── Window management ────────────────────────────────────────────────────

  /**
   * Advance the window counter after a question is resolved
   * (triage returned `respond` or `not_found`).
   */
  resetWindow(): void {
    this._window++;
  }

  /**
   * Bump the window counter when a topic switch is detected mid-session
   * (triage returned `new_topic`).
   * Semantically identical to resetWindow — named separately for clarity at call sites.
   */
  bumpWindow(): void {
    this._window++;
  }

  // ─── Window queries ───────────────────────────────────────────────────────

  /**
   * All turns in the current window formatted for LLM message arrays.
   * Passed to triage and respond — does not include turns from earlier windows.
   */
  currentWindowTurns(): ConversationTurn[] {
    return this._turns
      .filter((t) => t.window === this._window)
      .map((t) => ({ role: t.role, content: t.content }));
  }

  /**
   * Number of assistant turns in the current window.
   * Used to enforce the clarification limit — once this equals
   * CONFIG.retrieval.clarificationLimit, triage must not return `clarify`.
   */
  clarificationsUsed(): number {
    return this._turns.filter(
      (t) => t.role === "assistant" && t.window === this._window,
    ).length;
  }

  /** Total user turns across the full session history (for quota enforcement). */
  totalUserTurns(): number {
    return this._turns.filter((t) => t.role === "user").length;
  }

  /**
   * Returns true if the session has reached the turn quota.
   * Checked before any LLM calls are made — no quota call ever hits the LLM.
   */
  isQuotaExceeded(): boolean {
    return this.totalUserTurns() >= CONFIG.sessions.maxTurnsPerSession;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /**
   * Rewrite the full session JSONL file from in-memory state.
   * The file is always written in full (not appended) to maintain a clean,
   * consistent record — consistent with the design spec.
   */
  async save(): Promise<void> {
    const lines: JsonlLine[] = [
      {
        type: "session",
        session_id: this.session_id,
        user_id: this.user_id,
        created_at: this.created_at,
      },
    ];

    if (this._title) {
      lines.push({ type: "title", value: this._title });
    }

    lines.push(...this._turns);

    const dir = join(CONFIG.sessions.dir, this.user_id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      this.filePath,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf-8",
    );
  }
}
