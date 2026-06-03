export interface Category {
  id: string;
  name: string;
  type: 'fixed_budget' | 'variable';
  monthly_budget?: number;
  created?: string;
  updated?: string;
}
