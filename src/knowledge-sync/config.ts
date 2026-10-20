/** Maintenance uploads are independent of chat attachment configuration. */
export const SYNC_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const isIgnoredSyncFile = (name: string) =>
  /(?:^|\/)readme\.md$/i.test(name);
