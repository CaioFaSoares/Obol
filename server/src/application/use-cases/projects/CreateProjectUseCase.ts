import { Project } from '../../../domain/entities/Project';
import { ProjectRepository } from '../../../domain/interfaces/ProjectRepository';
import { roundCurrency } from '../../../domain/utils/mathUtils';

export class CreateProjectUseCase {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async execute(data: Partial<Project>): Promise<Project> {
    if (data.total_value !== undefined) {
      data = { ...data, total_value: roundCurrency(data.total_value) };
    }
    return await this.projectRepository.create({
      ...data,
      status: 'active'
    });
  }
}
