/**
 * Counts of records removed by a full financial-data reset. The owner
 * identity and its sessions are intentionally outside this contract.
 */
export interface ClearedFinancialData {
  transactions: number;
  invoices: number;
  recurrences: number;
  cards: number;
  accounts: number;
  categories: number;
  projects: number;
}

export interface DatabaseMaintenanceRepository {
  /**
   * Deletes every financial record, children before parents, so relation
   * constraints and cascade rules never leave orphaned rows behind.
   */
  clearFinancialData(): Promise<ClearedFinancialData>;
}
