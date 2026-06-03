import { Project } from '../entities/Project';
import { ListOptions } from './Common';

export interface ProjectRepository {
  findById(id: string): Promise<Project>;
  listAll(options?: ListOptions): Promise<Project[]>;
  create(data: Partial<Project>): Promise<Project>;
  update(id: string, data: Partial<Project>): Promise<Project>;
  delete(id: string): Promise<void>;
}
