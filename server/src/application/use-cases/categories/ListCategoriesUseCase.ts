import { Category } from '../../../domain/entities/Category';
import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';

export class ListCategoriesUseCase {
  constructor(private readonly categoryRepository: CategoryRepository) {}

  async execute(): Promise<Category[]> {
    return await this.categoryRepository.listAll();
  }
}
