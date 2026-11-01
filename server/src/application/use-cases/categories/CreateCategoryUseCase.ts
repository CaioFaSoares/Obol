import { Category } from '../../../domain/entities/Category';
import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';
import { roundCurrency } from '../../../domain/utils/mathUtils';

export class CreateCategoryUseCase {
  constructor(private readonly categoryRepository: CategoryRepository) {}

  async execute(data: Partial<Category>): Promise<Category> {
    if (data.monthly_budget !== undefined && data.monthly_budget !== null) {
      data = { ...data, monthly_budget: roundCurrency(data.monthly_budget) };
    }
    return await this.categoryRepository.create(data);
  }
}
