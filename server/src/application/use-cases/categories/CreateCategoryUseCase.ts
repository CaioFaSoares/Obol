import { Category } from '../../../domain/entities/Category';
import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';

export class CreateCategoryUseCase {
  constructor(private readonly categoryRepository: CategoryRepository) {}

  async execute(data: Partial<Category>): Promise<Category> {
    return await this.categoryRepository.create(data);
  }
}
