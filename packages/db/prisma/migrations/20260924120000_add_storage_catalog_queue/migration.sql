-- Storage catalog: queue of library changes that StorageCatalogService mirrors into storage (catalog/*.json).
--
-- Changes are captured with row triggers instead of calls from the services because several paths change
-- assets in bulk without going through a per-asset service method (trash/restore descendant cascades,
-- project deletion, the purge pipeline's raw SQL, version-stack symlink renames). A trigger sees every one
-- of them, inside the same transaction, so a change is queued exactly when it commits.
--
-- Queue ids: an asset id, 'project:<project id>' or 'field:<metadata field key>'. The primary key keeps one
-- row per changed object no matter how many times it changes before the next sync.

-- CreateTable
CREATE TABLE "storage_catalog_queue" (
    "id" TEXT NOT NULL,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_catalog_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_catalog_queue_queued_at_idx" ON "storage_catalog_queue"("queued_at");

CREATE FUNCTION storage_catalog_enqueue(queue_id TEXT) RETURNS void AS $$
BEGIN
  INSERT INTO storage_catalog_queue (id) VALUES (queue_id) ON CONFLICT (id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Assets: only the columns the catalog records. Size, file counts and media info change constantly during
-- uploads and transcodes and are not part of the library's structure, so they do not queue anything.
CREATE FUNCTION storage_catalog_asset_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM storage_catalog_enqueue(OLD.id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
      NEW.name, NEW.type, NEW.status, NEW.is_deleted, NEW.deleted_at, NEW.sort_index, NEW.parent_id,
      NEW.target_id, NEW.storage_key_id, NEW.project_id, NEW.media_type, NEW.creator_id
    ) IS NOT DISTINCT FROM (
      OLD.name, OLD.type, OLD.status, OLD.is_deleted, OLD.deleted_at, OLD.sort_index, OLD.parent_id,
      OLD.target_id, OLD.storage_key_id, OLD.project_id, OLD.media_type, OLD.creator_id
    ) THEN
    RETURN NEW;
  END IF;
  PERFORM storage_catalog_enqueue(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_catalog_assets
AFTER INSERT OR UPDATE OR DELETE ON "assets"
FOR EACH ROW EXECUTE FUNCTION storage_catalog_asset_changed();

CREATE FUNCTION storage_catalog_metadata_value_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM storage_catalog_enqueue(OLD.asset_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.asset_id IS DISTINCT FROM NEW.asset_id THEN
    PERFORM storage_catalog_enqueue(OLD.asset_id);
  END IF;
  PERFORM storage_catalog_enqueue(NEW.asset_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_catalog_asset_metadata_values
AFTER INSERT OR UPDATE OR DELETE ON "asset_metadata_values"
FOR EACH ROW EXECUTE FUNCTION storage_catalog_metadata_value_changed();

CREATE FUNCTION storage_catalog_project_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM storage_catalog_enqueue('project:' || OLD.id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
      NEW.name, NEW.team_id, NEW.root_folder_id, NEW.share_root_id, NEW.metadata_overrides::text
    ) IS NOT DISTINCT FROM (
      OLD.name, OLD.team_id, OLD.root_folder_id, OLD.share_root_id, OLD.metadata_overrides::text
    ) THEN
    RETURN NEW;
  END IF;
  PERFORM storage_catalog_enqueue('project:' || NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_catalog_projects
AFTER INSERT OR UPDATE OR DELETE ON "projects"
FOR EACH ROW EXECUTE FUNCTION storage_catalog_project_changed();

CREATE FUNCTION storage_catalog_metadata_field_changed() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM storage_catalog_enqueue('field:' || OLD.key);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM storage_catalog_enqueue('field:' || NEW.key);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER storage_catalog_metadata_fields
AFTER INSERT OR UPDATE OR DELETE ON "metadata_fields"
FOR EACH ROW EXECUTE FUNCTION storage_catalog_metadata_field_changed();
