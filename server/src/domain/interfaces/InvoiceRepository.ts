import { Invoice } from '../entities/Invoice';
import { ListOptions } from './Common';

export interface InvoiceRepository {
  findById(id: string): Promise<Invoice>;
  findByPeriodAndCard(cardId: string, period: string): Promise<Invoice | null>;
  listAll(options?: ListOptions): Promise<Invoice[]>;
  create(data: Partial<Invoice>): Promise<Invoice>;
  update(id: string, data: Partial<Invoice>): Promise<Invoice>;
  delete(id: string): Promise<void>;
}
