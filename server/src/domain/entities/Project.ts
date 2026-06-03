export interface Project {
  id: string;
  name: string;
  total_value: number;
  status: 'active' | 'completed';
  created?: string;
  updated?: string;
}
