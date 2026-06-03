import PocketBase from 'pocketbase';
import { Recurrence } from '../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../domain/interfaces/RecurrenceRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseRecurrenceRepository implements RecurrenceRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Recurrence> {
    const record = await this.pb.collection('recurrences').getOne(id);
    return record as unknown as Recurrence;
  }

  async listAll(options?: ListOptions): Promise<Recurrence[]> {
    const pbOptions: any = {};
    if (options?.sort) {
      pbOptions.sort = options.sort;
    }
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('recurrences').getFullList(pbOptions);
    return records as unknown as Recurrence[];
  }

  async create(data: Partial<Recurrence>): Promise<Recurrence> {
    const record = await this.pb.collection('recurrences').create(data);
    return record as unknown as Recurrence;
  }

  async update(id: string, data: Partial<Recurrence>): Promise<Recurrence> {
    const record = await this.pb.collection('recurrences').update(id, data);
    return record as unknown as Recurrence;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('recurrences').delete(id);
  }
}
