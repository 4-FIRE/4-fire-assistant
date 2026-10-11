export interface MemoryMatch { path: string; line: number; excerpt: string }
export interface MemoryResults { entries: MemoryMatch[]; nextOffset: number | null; skipped: string[] }
/** Search user-owned documents. Reads and changes use ordinary file tools. */
export interface MemoryPort {
  list(query?: string, offset?: number, scope?: string): Promise<MemoryResults>;
}
