/**
 * The slice of the Firestore admin SDK this package uses.
 *
 * Declared structurally (and narrowly) for two reasons: the repos stay unit
 * testable against an in-memory double with no emulator (docs/00 §0.5), and the
 * *only* mutating method in sight is `set` on `proposals` / `auditLog` — the two
 * collections the engine's service account may write (docs/05 §5.1).
 */

export interface DocSnapshotLike {
  readonly id: string;
  readonly exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface QuerySnapshotLike {
  readonly docs: readonly DocSnapshotLike[];
}

export interface QueryLike {
  where(field: string, op: string, value: unknown): QueryLike;
  get(): Promise<QuerySnapshotLike>;
}

export interface DocRefLike {
  get(): Promise<DocSnapshotLike>;
  set(data: Record<string, unknown>): Promise<unknown>;
}

export interface CollectionLike extends QueryLike {
  doc(id: string): DocRefLike;
}

export interface FirestoreLike {
  collection(path: string): CollectionLike;
}
