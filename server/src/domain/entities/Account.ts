export interface Account {
  id: string;
  name: string;
  type: 'checking' | 'savings' | 'investment';
  initial_balance: number;
  created?: string;
  updated?: string;
}
