import { Project } from '../../../domain/entities/Project';
import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { NotFoundError } from '../../../domain/errors';

export class CompleteProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(id: string): Promise<Project> {
    const project = await this.projectRepository.findById(id);
    if (!project) {
      throw new NotFoundError('Projeto não encontrado.');
    }
    return await this.projectRepository.update(id, { status: 'completed' });
  }
}
