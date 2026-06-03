export interface Card {
  id: string;
  name: string;
  closing_day: number;
  due_day: number;
  limit: number;
  created?: string;
  updated?: string;
}
