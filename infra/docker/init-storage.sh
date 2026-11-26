#!/bin/sh
set -eu
attempt=0
until mcli alias set internal http://storage:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
  attempt=$((attempt+1))
  if [ "$attempt" -ge 60 ]; then echo "Object store did not start" >&2; exit 1; fi
  sleep 2
done
mcli mb --ignore-existing internal/noon-assets
mcli admin policy create internal noon-assets /init/bucket-policy.json
mcli admin user add internal noon-storage "$STORAGE_APP_SECRET"
if ! mcli admin user info internal noon-storage | grep -Eq '^PolicyName:.*noon-assets'; then
  mcli admin policy attach internal noon-assets --user noon-storage
fi
