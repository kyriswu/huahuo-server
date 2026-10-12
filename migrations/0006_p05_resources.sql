CREATE TABLE upload_sessions (
 upload_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), workspace_id uuid NOT NULL,
 resource_id uuid NOT NULL UNIQUE, reservation_id uuid NOT NULL UNIQUE REFERENCES storage_reservations(reservation_id),
 source_scene text NOT NULL, file_name text NOT NULL, mime_type text NOT NULL,
 expected_bytes bigint NOT NULL CHECK(expected_bytes>0), expected_sha256 char(64), duration_seconds double precision NOT NULL DEFAULT 0,
 status text NOT NULL CHECK(status IN ('initiated','uploading','uploaded','completed','failed','expired')),
 received_bytes bigint NOT NULL DEFAULT 0, received_sha256 char(64), verified_duration double precision, object_version text,
 storage_driver text NOT NULL, storage_bucket text, error_code text,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,user_id) REFERENCES workspaces(id,user_id), UNIQUE(upload_id,user_id,workspace_id)
);
CREATE TABLE upload_parts (
 upload_id uuid NOT NULL REFERENCES upload_sessions(upload_id), part_no integer NOT NULL CHECK(part_no=1),
 byte_start bigint NOT NULL CHECK(byte_start=0), byte_end bigint NOT NULL CHECK(byte_end>=0), sha256 char(64) NOT NULL,
 PRIMARY KEY(upload_id,part_no)
);
CREATE TABLE resources (
 resource_id uuid PRIMARY KEY, user_id uuid NOT NULL, workspace_id uuid NOT NULL, upload_id uuid NOT NULL UNIQUE,
 source_scene text NOT NULL, file_name text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes>0),
 duration_seconds double precision NOT NULL, sha256 char(64) NOT NULL, object_key uuid NOT NULL UNIQUE, object_version text NOT NULL,
 storage_driver text NOT NULL, storage_bucket text, status text NOT NULL CHECK(status IN ('ready','deleting','deleted','quarantined')),
 processing_status text NOT NULL DEFAULT 'inspection_pending' CHECK(processing_status IN ('inspection_pending','inspected','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 FOREIGN KEY(upload_id,user_id,workspace_id) REFERENCES upload_sessions(upload_id,user_id,workspace_id),
 UNIQUE(resource_id,user_id,workspace_id)
);
CREATE TABLE resource_refs (
 resource_id uuid NOT NULL, user_id uuid NOT NULL, workspace_id uuid NOT NULL, ref_kind text NOT NULL, ref_id_external text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(resource_id,ref_kind,ref_id_external),
 FOREIGN KEY(resource_id,user_id,workspace_id) REFERENCES resources(resource_id,user_id,workspace_id)
);
CREATE TABLE storage_jobs (
 task_id uuid PRIMARY KEY REFERENCES tasks(id), upload_id uuid REFERENCES upload_sessions(upload_id), resource_id uuid REFERENCES resources(resource_id),
 operation text NOT NULL CHECK(operation IN ('inspect','delete','expire')), UNIQUE(upload_id,operation), UNIQUE(resource_id,operation)
);
CREATE TABLE resource_delete_requests (
 resource_id uuid PRIMARY KEY REFERENCES resources(resource_id), task_id uuid NOT NULL REFERENCES tasks(id),
 requested_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
ALTER TABLE app_users ADD COLUMN avatar_resource_id uuid REFERENCES resources(resource_id);
CREATE INDEX resources_scope ON resources(user_id,workspace_id,created_at DESC);
CREATE INDEX upload_expiry ON upload_sessions(status,expires_at);
GRANT SELECT,INSERT,UPDATE ON upload_sessions,upload_parts,resources,resource_delete_requests,storage_jobs TO huahuo_api;
GRANT SELECT,INSERT,DELETE ON resource_refs TO huahuo_api;
GRANT SELECT,UPDATE ON upload_sessions,resources,resource_delete_requests,storage_reservations TO huahuo_worker;
GRANT SELECT ON resource_refs,storage_jobs,upload_parts TO huahuo_worker;
GRANT SELECT ON upload_sessions,upload_parts,resources,resource_refs,resource_delete_requests,storage_jobs TO huahuo_admin;
GRANT SELECT,UPDATE ON upload_sessions,storage_reservations TO huahuo_scheduler;
GRANT SELECT,INSERT ON storage_jobs TO huahuo_scheduler;
