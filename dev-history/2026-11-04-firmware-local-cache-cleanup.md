# Firmware local cache cleanup

After upload, library publication, object verification and website visibility verification succeed, persist the successful job before deleting its managed local ZIP, receipt and empty cache directory. Cloud objects, links and job history remain available.

Cleanup runs outside transfer retries. Permission errors remain pending without changing transfer success or uploading again. Startup and idle polling retry pending cleanup every minute. Shared unfinished/retryable jobs and download-only results keep their cache; uploads without verified library publication also retain local files. Deletion uses exact managed names and directory descriptors, rejects symlinks and never recursively removes directories.

Implementation and Python tests live in the intentionally ignored `local-download-service/`; do not add that directory to Git or deploy it to VPS. Only the local service needs restarting.

Validation: the local Python suite passed 60 tests, followed by 18 library workflow tests including the two additional directory-symlink and cleanup-status-write failure cases. Coverage includes publication failure retaining cache, successful retry deleting it, interrupted cleanup recovered at startup, cleanup permission errors preserving transfer success, shared download-only/retryable jobs, exact-file deletion and unmanaged paths. Fixtures use temporary files and storage endpoints.

Confirmed both existing local firmware jobs were successful, had verified upload receipts and library visibility, and no job was active. Gracefully restarted the local service; startup cleanup removed both ZIPs, their receipts and empty directories (2,493,529,982 ZIP bytes, about 2.32 GiB). Both persisted tasks remain successful with completed cleanup records, and the downloads directory is empty. The replacement background service is running. No VPS access, configuration changes, cloud object deletion or production firmware transfer was performed.
