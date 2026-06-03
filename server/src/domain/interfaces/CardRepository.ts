import { Card } from '../entities/Card';
import { ListOptions } from './Common';

export interface CardRepository {
  findById(id: string): Promise<Card>;
  listAll(options?: ListOptions): Promise<Card[]>;
  create(data: Partial<Card>): Promise<Card>;
  update(id: string, data: Partial<Card>): Promise<Card>;
  delete(id: string): Promise<void>;
}
