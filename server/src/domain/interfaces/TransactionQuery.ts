import { Transaction } from '../entities/Transaction';
import { ListOptions } from './Common';

export type TransactionStatusFilter = 'all' | 'pending' | 'realized';
export type TransactionTypeFilter = 'all' | Transaction['type'];
export type TransactionSimulationFilter = 'all' | 'real' | 'simulated';
export type TransactionScheduledFilter = 'all' | 'scheduled' | 'unscheduled';
export type TransactionDateField = 'expected_date' | 'realized_date';

/** Structured filters accepted by the ledger endpoints. */
export interface TransactionQueryFilters {
  search?: string;
  status?: TransactionStatusFilter;
  type?: TransactionTypeFilter;
  simulation?: TransactionSimulationFilter;
  scheduled?: TransactionScheduledFilter;
  accountId?: string;
  cardId?: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  dateField?: TransactionDateField;
}

/** Paginated and sorted transaction query; `filter` remains for trusted existing callers. */
export interface TransactionListOptions extends ListOptions, TransactionQueryFilters {
  expandInvoice?: boolean;
}

export type TransactionSummaryRow = Pick<Transaction, 'amount' | 'type'>;

export interface TransactionSummary {
  incomeTotal: number;
  expenseTotal: number;
  netTotal: number;
  count: number;
}

export interface TransactionListItem extends Transaction {
  /** Invoice period attached to the transaction, populated for Ledger list requests. */
  invoice_period?: string;
}
