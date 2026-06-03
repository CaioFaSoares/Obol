export interface Recurrence {
  id: string;
  name: string;
  amount: number;
  payday: number;
  type: 'income' | 'expense';
  status: 'active' | 'paused' | 'ended';
  account_id?: string;
  card_id?: string;
  category_id?: string;
  end_date?: string;
  total_installments?: number;
  skipped_periods?: string[];
  created?: string;
  updated?: string;
}
