import { Recurrence } from '../entities/Recurrence';
import { ListOptions } from './Common';

export interface RecurrenceRepository {
  findById(id: string): Promise<Recurrence>;
  listAll(options?: ListOptions): Promise<Recurrence[]>;
  create(data: Partial<Recurrence>): Promise<Recurrence>;
  update(id: string, data: Partial<Recurrence>): Promise<Recurrence>;
  delete(id: string): Promise<void>;
}
