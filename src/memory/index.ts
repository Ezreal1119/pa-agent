/** Long-term memory will live behind this module. */
export interface MemoryStore {
  search(query: string): Promise<readonly string[]>;
}

