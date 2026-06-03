import { Project } from '../../../domain/entities/Project';
import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';

export class CreateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(data: Partial<Project>): Promise<Project> {
    return await this.projectRepository.create({
      ...data,
      status: 'active'
    });
  }
}
