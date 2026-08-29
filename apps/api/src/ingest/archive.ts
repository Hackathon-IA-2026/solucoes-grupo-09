import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where WattSteer's raw payloads live.
 *
 * ONS publishes no version marker and offers no way to request a prior
 * vintage: once a file is overwritten, what it used to say is gone unless
 * WattSteer kept it. So this is not a cache. It is the only copy of every
 * belief the platform ever held about a closed period, and every backtest that
 * calls itself point-in-time is standing on it.
 *
 * **Content-addressed, not path-addressed.** The key is the sha256 of the
 * bytes, so writing the same payload twice is one object, a re-publication that
 * turns out to be byte-identical costs nothing, and the stored object verifies
 * itself — a truncated or swapped payload cannot masquerade as the vintage it
 * is filed under. What the object *was* (which dataset, which period, when it
 * was fetched) lives in `payload_custody`, where it can be queried.
 *
 * **Two implementations behind one interface**, and the production one is the
 * bucket. A Railway volume attaches to exactly one service and forbids replicas
 * on it, which would cap ingestion at a single worker and add downtime to every
 * redeploy; a Railway bucket is S3-compatible, shared across replicas, and
 * bills at $0.015/GB-month against a volume's $0.15 with free egress and
 * operations. The directory implementation is what compose and the tests use —
 * same interface, no credentials. See `docs/specs/data-platform.md`.
 */

/** A payload store. Both implementations are idempotent under a repeated `put`. */
export interface PayloadArchive {
  /** Which backing store this is — reported by the health view, never branched on. */
  readonly kind: "bucket" | "directory";
  /** Store bytes under `key`. Writing the same key twice is a no-op. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Read bytes back, or null when the key is absent (purged, or never held). */
  get(key: string): Promise<Uint8Array | null>;
  /** Drop bytes. Absent keys are not an error — retention must be re-runnable. */
  remove(key: string): Promise<void>;
}

/** What a payload is, for key purposes. */
export interface ArchiveKeyParts {
  /**
   * `bulk` for a downloaded file, `carga` for a carga API response, `weather`
   * for a Single Runs response. The family is the archive's top-level split, so
   * a transport that acquires bytes a different way gets its own segment.
   */
  family: "bulk" | "carga" | "weather";
  /** CKAN package id, or the carga series — the first path segment. */
  datasetSlug: string;
  contentSha256: string;
  /** File extension without the dot, lower-cased. */
  extension: string;
}

/**
 * The archive-relative locator stored in `payload_custody.archive_uri`.
 *
 * Relative, deliberately: an absolute path or a bucket URL would bake today's
 * mount point or endpoint into rows that must outlive both. Moving the archive
 * is then a config change, not a data migration.
 *
 * The two-character shard keeps a directory archive usable — a single directory
 * holding every payload WattSteer ever fetched is a directory no one can list.
 */
export function archiveKey(parts: ArchiveKeyParts): string {
  const sha = parts.contentSha256;
  return `${parts.family}/${parts.datasetSlug}/${sha.slice(0, 2)}/${sha}.${parts.extension}`;
}

/** The sha256 an archive key is built from, and the one custody records. */
export function payloadSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lower-cased extension for a wire format; `json` for a carga response. */
export function extensionForFormat(format: string): string {
  return format.toLowerCase();
}

/**
 * A directory-backed archive — compose, local development and the tests.
 *
 * Writes go through a temporary file and a rename, so a crash mid-write leaves
 * either the whole payload or nothing. A half-written object under a
 * content-addressed key is worse than a missing one: it would verify as the
 * vintage it is not.
 */
export function createDirectoryArchive(root: string): PayloadArchive {
  const base = resolve(root);

  /** Reject a key that would escape the archive root before touching the disk. */
  const pathFor = (key: string): string => {
    const target = resolve(join(base, key));
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`Archive key escapes the archive root: ${key}`);
    }
    return target;
  };

  return {
    kind: "directory",
    async put(key, bytes) {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      // Content-addressed: an object already at this key holds these bytes.
      const existing = await stat(target).catch(() => null);
      if (existing?.isFile()) {
        return;
      }
      const temporary = `${target}.${process.pid}.${Date.now()}.part`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    },
    async get(key) {
      const bytes = await readFile(pathFor(key)).catch(() => null);
      return bytes ? new Uint8Array(bytes) : null;
    },
    async remove(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

/** Credentials for an S3-compatible bucket (Railway's, MinIO, or AWS). */
export interface BucketArchiveOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Railway and MinIO need one; AWS infers it from the region. */
  endpoint?: string;
  region?: string;
}

/**
 * A bucket-backed archive, on Bun's built-in S3 client.
 *
 * No SDK dependency: the runtime already speaks S3, and adding a vendor client
 * to hold four strings would be the larger commitment. Only four operations are
 * used — write, read, exists, delete — which is exactly the subset every
 * S3-compatible store implements the same way, so the production store can be
 * swapped without touching a caller.
 */
export function createBucketArchive(options: BucketArchiveOptions): PayloadArchive {
  const client = new Bun.S3Client({
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.region ? { region: options.region } : {}),
  });

  return {
    kind: "bucket",
    async put(key, bytes) {
      if (await client.file(key).exists()) {
        return;
      }
      await client.write(key, bytes);
    },
    async get(key) {
      const file = client.file(key);
      if (!(await file.exists())) {
        return null;
      }
      return new Uint8Array(await file.arrayBuffer());
    },
    async remove(key) {
      // Deleting an absent object is not an error on S3, and must not be one
      // here either: retention re-runs over rows it has already purged.
      await client.delete(key).catch(() => {});
    },
  };
}

/** How the process was configured to retain payloads, if it was at all. */
export interface ArchiveConfig {
  bucket?: string;
  bucketAccessKeyId?: string;
  bucketSecretAccessKey?: string;
  bucketEndpoint?: string;
  bucketRegion?: string;
  directory?: string;
}

/**
 * Build the configured archive, or `undefined` when custody is switched off.
 *
 * `undefined` rather than a no-op archive, on purpose. A silently discarding
 * implementation would let a deployment run for a year believing it was the
 * custodian of its own history and discover otherwise the first time a backtest
 * asked for a vintage. Callers have to hold an optional and say what they do
 * without one; the worker says it loudly at boot.
 */
export function createPayloadArchive(config: ArchiveConfig): PayloadArchive | undefined {
  if (config.bucket && config.bucketAccessKeyId && config.bucketSecretAccessKey) {
    return createBucketArchive({
      bucket: config.bucket,
      accessKeyId: config.bucketAccessKeyId,
      secretAccessKey: config.bucketSecretAccessKey,
      endpoint: config.bucketEndpoint,
      region: config.bucketRegion,
    });
  }
  if (config.directory) {
    return createDirectoryArchive(config.directory);
  }
  return undefined;
}
