import PocketBase from 'pocketbase';
import { Category } from '../../domain/entities/Category';
import { CategoryRepository } from '../../domain/interfaces/CategoryRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseCategoryRepository implements CategoryRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Category> {
    const record = await this.pb.collection('categories').getOne(id);
    return record as unknown as Category;
  }

  async listAll(options?: ListOptions): Promise<Category[]> {
    const pbOptions: any = {
      sort: options?.sort || 'name',
    };
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('categories').getFullList(pbOptions);
    return records as unknown as Category[];
  }

  async create(data: Partial<Category>): Promise<Category> {
    const record = await this.pb.collection('categories').create(data);
    return record as unknown as Category;
  }

  async update(id: string, data: Partial<Category>): Promise<Category> {
    const record = await this.pb.collection('categories').update(id, data);
    return record as unknown as Category;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('categories').delete(id);
  }
}
