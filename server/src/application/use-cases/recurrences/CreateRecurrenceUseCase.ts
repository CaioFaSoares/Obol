import { Recurrence } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { resolveRecurrenceCadence } from '../../../domain/recurrence/cadence';
import { roundCurrency } from '../../../domain/utils/mathUtils';

function relation(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

export class CreateRecurrenceUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly accountRepository: AccountRepository,
    private readonly cardRepository: CardRepository
  ) {}

  async execute(body: Partial<Recurrence>): Promise<Recurrence> {
    const data: Partial<Recurrence> = {
      ...body,
      account_id: relation(body.account_id),
      card_id: relation(body.card_id),
      category_id: relation(body.category_id)
    };

    if (!data.name || !data.name.trim()) {
      throw new ValidationError('Recurrence name cannot be empty.');
    }
    if (!Number.isFinite(data.amount) || (data.amount as number) <= 0) {
      throw new ValidationError('Recurrence amount must be greater than zero.');
    }
    if (!Number.isInteger(data.payday) || (data.payday as number) < 1 || (data.payday as number) > 31) {
      throw new ValidationError('Recurrence payday must be between 1 and 31.');
    }
    const cadence = resolveRecurrenceCadence(data.frequency, data.weekday);
    if (data.total_installments !== undefined && data.total_installments !== null && data.total_installments <= 0) {
      throw new ValidationError('Total installments must be positive.');
    }
    if (data.account_id && data.card_id) {
      throw new ValidationError('A recurrence cannot use both a bank account and a card.');
    }

    if (data.account_id) {
      const account = await this.accountRepository.findById(data.account_id);
      if (!account) throw new NotFoundError(`Account ${data.account_id} was not found.`);
    }
    if (data.card_id) {
      const card = await this.cardRepository.findById(data.card_id);
      if (!card) throw new NotFoundError(`Card ${data.card_id} was not found.`);
    }

    return await this.recurrenceRepository.create({
      ...data,
      amount: roundCurrency(data.amount as number),
      frequency: cadence.frequency,
      weekday: cadence.weekday ?? 0,
      status: 'active'
    });
  }
}
