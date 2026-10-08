-- SHA-256 (lowercase hex) of the stored original, recorded when an upload is confirmed and kept in the
-- storage catalog. Null for files uploaded before this existed, folders and symlinks. The catalog triggers on
-- "assets" already fire on any UPDATE, so recording a hash queues the asset for the catalog like any change.
ALTER TABLE "assets" ADD COLUMN "content_hash" TEXT;
