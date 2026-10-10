export interface MemoryPage { id: string; revision: string; content: string; nextOffset: number | null }
export interface MemorySummary { id: string; revision: string; summary: string }
/** Knowledge is readable material, never an execution grant. System receipts cannot be edited by model tools. */
export interface MemoryPort {
  list(query?: string, offset?: number): Promise<{ entries: MemorySummary[]; nextOffset: number | null }>;
  read(id: string, offset?: number, revision?: string): Promise<MemoryPage | undefined>;
  save(content: string, id?: string, revision?: string): Promise<MemorySummary>;
  record(key: string, content: string, replace?: boolean): Promise<MemorySummary>;
  recorded(key: string): Promise<string | undefined>;
}
