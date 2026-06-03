import PocketBase from 'pocketbase';
import { Project } from '../../domain/entities/Project';
import { ProjectRepository } from '../../domain/interfaces/ProjectRepository';
import { ListOptions } from '../../domain/interfaces/Common';

export class PocketbaseProjectRepository implements ProjectRepository {
  constructor(private readonly pb: PocketBase) {}

  async findById(id: string): Promise<Project> {
    const record = await this.pb.collection('projects').getOne(id);
    return record as unknown as Project;
  }

  async listAll(options?: ListOptions): Promise<Project[]> {
    const pbOptions: any = {};
    if (options?.sort) {
      pbOptions.sort = options.sort;
    }
    if (options?.filter) {
      pbOptions.filter = options.filter;
    }
    const records = await this.pb.collection('projects').getFullList(pbOptions);
    return records as unknown as Project[];
  }

  async create(data: Partial<Project>): Promise<Project> {
    const record = await this.pb.collection('projects').create(data);
    return record as unknown as Project;
  }

  async update(id: string, data: Partial<Project>): Promise<Project> {
    const record = await this.pb.collection('projects').update(id, data);
    return record as unknown as Project;
  }

  async delete(id: string): Promise<void> {
    await this.pb.collection('projects').delete(id);
  }
}
