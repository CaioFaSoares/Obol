export interface Transaction {
  id: string;
  title: string;
  amount: number;
  type: 'income' | 'expense' | 'transfer';
  status: 'pending' | 'realized';
  expected_date: string;
  realized_date?: string;
  purchase_date?: string;
  is_recurring?: boolean;
  is_silent?: boolean;
  is_simulated?: boolean;
  is_scheduled?: boolean;
  account_id?: string;
  card_id?: string;
  category_id?: string;
  project_id?: string;
  invoice_id?: string;
  recurrence_id?: string;
  destination_account_id?: string;
  created?: string;
  updated?: string;
}

/**
 * Client-editable transaction fields.
 *
 * An omitted field keeps its stored value; `null` clears a canonical optional
 * relation or date. `invoice_id` is server-computed routing and
 * `recurrence_id` is create-only, so neither appears in an update patch.
 */
export interface TransactionUpdatePatch {
  readonly title?: string;
  readonly amount?: number;
  readonly type?: 'income' | 'expense' | 'transfer';
  readonly status?: 'pending' | 'realized';
  readonly expected_date?: string;
  readonly realized_date?: string | null;
  readonly purchase_date?: string | null;
  readonly is_recurring?: boolean;
  readonly is_silent?: boolean;
  readonly is_simulated?: boolean;
  readonly is_scheduled?: boolean;
  readonly account_id?: string | null;
  readonly card_id?: string | null;
  readonly category_id?: string | null;
  readonly project_id?: string | null;
  readonly destination_account_id?: string | null;
}

/**
 * Full write body for the transaction storage record.
 *
 * PocketBase stores the empty string for an unset relation or date, so a clear
 * is written as `''` and the stored entity keeps its undefined-based shape.
 * `invoice_id` and `recurrence_id` are internal routing fields written by the
 * use case, never by a client patch.
 */
export function storedTransactionFields(transaction: Transaction): Partial<Transaction> {
  return {
    title: transaction.title,
    amount: transaction.amount,
    type: transaction.type,
    status: transaction.status,
    expected_date: transaction.expected_date,
    realized_date: transaction.realized_date ?? '',
    purchase_date: transaction.purchase_date ?? '',
    is_recurring: transaction.is_recurring === true,
    is_silent: transaction.is_silent === true,
    is_simulated: transaction.is_simulated === true,
    is_scheduled: transaction.is_scheduled === true,
    account_id: transaction.account_id ?? '',
    card_id: transaction.card_id ?? '',
    category_id: transaction.category_id ?? '',
    project_id: transaction.project_id ?? '',
    invoice_id: transaction.invoice_id ?? '',
    recurrence_id: transaction.recurrence_id ?? '',
    destination_account_id: transaction.destination_account_id ?? ''
  };
}
