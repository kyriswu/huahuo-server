-- Commit-time hints only. No backfill, grants, or changes to session validity.
CREATE FUNCTION public.notify_bearer_auth_cache_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    PERFORM pg_notify('bearer_auth_cache', 'user:' || OLD.id::text);
  ELSE
    PERFORM pg_notify('bearer_auth_cache', 'access:' || OLD.access_hash);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER users_bearer_auth_cache_status
AFTER UPDATE OF status, deleted_at ON public.users
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER users_bearer_auth_cache_delete
AFTER DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER sessions_bearer_auth_cache_status
AFTER UPDATE OF access_hash, access_jti, access_expires_at, expires_at, revoked_at ON public.user_sessions
FOR EACH ROW
WHEN (ROW(OLD.access_hash, OLD.access_jti, OLD.access_expires_at, OLD.expires_at, OLD.revoked_at)
  IS DISTINCT FROM ROW(NEW.access_hash, NEW.access_jti, NEW.access_expires_at, NEW.expires_at, NEW.revoked_at))
EXECUTE FUNCTION public.notify_bearer_auth_cache_change();

CREATE TRIGGER sessions_bearer_auth_cache_delete
AFTER DELETE ON public.user_sessions
FOR EACH ROW EXECUTE FUNCTION public.notify_bearer_auth_cache_change();
