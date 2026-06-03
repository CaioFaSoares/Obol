export interface Invoice {
  id: string;
  card_id: string;
  period: string; // e.g., '2026-05'
  due_date: string;
  status: 'OPEN' | 'CLOSED' | 'PAID';
  total_amount: number;
  paid_amount?: number;
  created?: string;
  updated?: string;
}
