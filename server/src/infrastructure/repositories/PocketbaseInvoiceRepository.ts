import PocketBase from 'pocketbase';
import { Invoice } from '../../domain/entities/Invoice';
import { InvoiceRepository } from '../../domain/interfaces/InvoiceRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseInvoiceRepository implements InvoiceRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Invoice> {
    const record = await this.pb.collection('invoices').getOne(id);
    return record as unknown as Invoice;
  }

  async findByPeriodAndCard(cardId: string, period: string): Promise<Invoice | null> {
    try {
      const record = await this.pb.collection('invoices').getFirstListItem(
        `card_id = '${cardId}' && period = '${period}'`
      );
      return record as unknown as Invoice;
    } catch (err: any) {
      if (err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async listAll(options?: ListOptions): Promise<Invoice[]> {
    const pbOptions: any = {
      sort: options?.sort || '-period',
    };
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    if (options?.expand) {
      pbOptions.expand = options.expand;
    }
    const records = await this.pb.collection('invoices').getFullList(pbOptions);
    return records as unknown as Invoice[];
  }

  async create(data: Partial<Invoice>): Promise<Invoice> {
    const record = await this.pb.collection('invoices').create(data);
    return record as unknown as Invoice;
  }

  async update(id: string, data: Partial<Invoice>): Promise<Invoice> {
    const record = await this.pb.collection('invoices').update(id, data);
    return record as unknown as Invoice;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('invoices').delete(id);
  }
}
