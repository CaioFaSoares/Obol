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
