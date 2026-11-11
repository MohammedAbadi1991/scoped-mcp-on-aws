import { randomUUID } from "node:crypto";
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

export interface Note {
  id: string;
  title: string;
  body: string;
  createdBy: string;
  createdAt: string;
}

export interface NotesStore {
  list(limit: number): Promise<Note[]>;
  get(id: string): Promise<Note | undefined>;
  create(input: { title: string; body: string; createdBy: string }): Promise<Note>;
  /** Returns false when the note did not exist. */
  delete(id: string): Promise<boolean>;
}

/** Time-sortable ID: 9 base36 chars of milliseconds, then 8 random hex chars. */
export function newNoteId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, "0")}-${randomUUID().slice(0, 8)}`;
}

export const NOTE_ID_PATTERN = /^[0-9a-z]{9}-[0-9a-f]{8}$/;

/**
 * All notes share one partition so a Query returns them newest first. That is
 * fine for a demo or a small team; at scale, partition by tenant or owner.
 */
const PK = "NOTE";

export class DynamoNotesStore implements NotesStore {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async list(limit: number): Promise<Note[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": PK },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (out.Items ?? []).map(toNote);
  }

  async get(id: string): Promise<Note | undefined> {
    const out = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: PK, sk: id } }),
    );
    return out.Item ? toNote(out.Item) : undefined;
  }

  async create(input: { title: string; body: string; createdBy: string }): Promise<Note> {
    const note: Note = { id: newNoteId(), createdAt: new Date().toISOString(), ...input };
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: PK, sk: note.id, ...note },
        ConditionExpression: "attribute_not_exists(sk)",
      }),
    );
    return note;
  }

  async delete(id: string): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: PK, sk: id },
          ConditionExpression: "attribute_exists(sk)",
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}

function toNote(item: Record<string, unknown>): Note {
  return {
    id: String(item.id),
    title: String(item.title),
    body: String(item.body),
    createdBy: String(item.createdBy),
    createdAt: String(item.createdAt),
  };
}

/** For tests and local runs. */
export class InMemoryNotesStore implements NotesStore {
  private readonly notes = new Map<string, Note>();

  async list(limit: number): Promise<Note[]> {
    return [...this.notes.values()].sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
  }

  async get(id: string): Promise<Note | undefined> {
    return this.notes.get(id);
  }

  async create(input: { title: string; body: string; createdBy: string }): Promise<Note> {
    const note: Note = { id: newNoteId(), createdAt: new Date().toISOString(), ...input };
    this.notes.set(note.id, note);
    return note;
  }

  async delete(id: string): Promise<boolean> {
    return this.notes.delete(id);
  }
}
