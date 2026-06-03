import { Category } from '../entities/Category';
import { ListOptions } from './Common';

export interface CategoryRepository {
  findById(id: string): Promise<Category>;
  listAll(options?: ListOptions): Promise<Category[]>;
  create(data: Partial<Category>): Promise<Category>;
  update(id: string, data: Partial<Category>): Promise<Category>;
  delete(id: string): Promise<void>;
}
