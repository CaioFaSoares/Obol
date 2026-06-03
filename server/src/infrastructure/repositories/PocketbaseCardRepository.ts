import PocketBase from 'pocketbase';
import { Card } from '../../domain/entities/Card';
import { CardRepository } from '../../domain/interfaces/CardRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseCardRepository implements CardRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Card> {
    const record = await this.pb.collection('cards').getOne(id);
    return record as unknown as Card;
  }

  async listAll(options?: ListOptions): Promise<Card[]> {
    const pbOptions: any = {
      sort: options?.sort || 'name',
    };
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('cards').getFullList(pbOptions);
    return records as unknown as Card[];
  }

  async create(data: Partial<Card>): Promise<Card> {
    const record = await this.pb.collection('cards').create(data);
    return record as unknown as Card;
  }

  async update(id: string, data: Partial<Card>): Promise<Card> {
    const record = await this.pb.collection('cards').update(id, data);
    return record as unknown as Card;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('cards').delete(id);
  }
}
