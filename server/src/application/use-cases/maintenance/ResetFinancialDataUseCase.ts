import type {
  ClearedFinancialData,
  DatabaseMaintenanceRepository,
} from '../../../domain/interfaces/DatabaseMaintenanceRepository';

export interface ResetFinancialDataResult {
  cleared: ClearedFinancialData;
  total: number;
}

/**
 * Clears all ledger data while preserving the deployment owner and their
 * sessions. Destructive by design: callers must require an explicit
 * confirmation before invoking it.
 */
export class ResetFinancialDataUseCase {
  constructor(private readonly maintenanceRepository: DatabaseMaintenanceRepository) {}

  async execute(): Promise<ResetFinancialDataResult> {
    const cleared = await this.maintenanceRepository.clearFinancialData();
    const total = Object.values(cleared).reduce((sum, count) => sum + count, 0);
    return { cleared, total };
  }
}
