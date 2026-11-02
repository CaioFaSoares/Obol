import { describe, expect, test } from 'bun:test';
import { UpdateRecurrenceUseCase } from '../src/application/use-cases/recurrences/UpdateRecurrenceUseCase';
import { ValidationError } from '../src/domain/errors';
import type { Account } from '../src/domain/entities/Account';
import type { Card } from '../src/domain/entities/Card';
import type { Category } from '../src/domain/entities/Category';
import type { Recurrence } from '../src/domain/entities/Recurrence';

// Real use case over mutable in-memory storage ports. Rows keep the blank
// relation/date representation PocketBase returns, so a clear is observable as
// an empty string or zero.

class MemoryRecurrenceRepository {
  constructor(readonly rows: Recurrence[]) {}

  async findById(id: string): Promise<Recurrence> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown recurrence ${id}`);
    return found;
  }

  async listAll(): Promise<Recurrence[]> {
    return this.rows;
  }

  async create(data: Partial<Recurrence>): Promise<Recurrence> {
    const row = { ...data, id: data.id ?? `rec-${this.rows.length + 1}` } as Recurrence;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Recurrence>): Promise<Recurrence> {
    const row = await this.findById(id);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryAccountRepository {
  constructor(readonly rows: Account[]) {}

  async findById(id: string): Promise<Account> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown account ${id}`);
    return found;
  }

  async listAll(): Promise<Account[]> {
    return this.rows;
  }

  async create(data: Partial<Account>): Promise<Account> {
    const row = { ...data, id: data.id ?? `acc-${this.rows.length + 1}` } as Account;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Account>): Promise<Account> {
    const row = this.rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`Unknown account ${id}`);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryCardRepository {
  constructor(readonly rows: Card[]) {}

  async findById(id: string): Promise<Card> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown card ${id}`);
    return found;
  }

  async listAll(): Promise<Card[]> {
    return this.rows;
  }

  async create(data: Partial<Card>): Promise<Card> {
    const row = { ...data, id: data.id ?? `card-${this.rows.length + 1}` } as Card;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Card>): Promise<Card> {
    const row = this.rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`Unknown card ${id}`);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

class MemoryCategoryRepository {
  constructor(readonly rows: Category[]) {}

  async findById(id: string): Promise<Category> {
    const found = this.rows.find(candidate => candidate.id === id);
    if (!found) throw new Error(`Unknown category ${id}`);
    return found;
  }

  async listAll(): Promise<Category[]> {
    return this.rows;
  }

  async create(data: Partial<Category>): Promise<Category> {
    const row = { ...data, id: data.id ?? `cat-${this.rows.length + 1}` } as Category;
    this.rows.push(row);
    return row;
  }

  async update(id: string, data: Partial<Category>): Promise<Category> {
    const row = this.rows.find(candidate => candidate.id === id);
    if (!row) throw new Error(`Unknown category ${id}`);
    Object.assign(row, data);
    return row;
  }

  async delete(id: string): Promise<void> {
    const index = this.rows.findIndex(candidate => candidate.id === id);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function storedRecurrence(overrides: Partial<Recurrence> = {}): Recurrence {
  return {
    id: 'rec-1',
    name: 'Aluguel',
    amount: 100,
    payday: 5,
    type: 'expense',
    status: 'active',
    account_id: 'acc-1',
    card_id: '',
    category_id: 'cat-1',
    end_date: '2026-06-10T00:00:00.000Z',
    total_installments: 6,
    skipped_periods: [],
    ...overrides
  };
}

function buildUseCase(recurrence: Recurrence) {
  const recurrences = new MemoryRecurrenceRepository([recurrence]);
  const accounts = new MemoryAccountRepository([
    { id: 'acc-1', name: 'Corrente', type: 'checking', initial_balance: 1000 }
  ]);
  const cards = new MemoryCardRepository([
    { id: 'card-1', name: 'Cartão', closing_day: 15, due_day: 25, limit: 5000 }
  ]);
  const categories = new MemoryCategoryRepository([
    { id: 'cat-1', name: 'Moradia', type: 'fixed_budget' }
  ]);
  return {
    useCase: new UpdateRecurrenceUseCase(recurrences, accounts, cards, categories),
    recurrences
  };
}

describe('UpdateRecurrenceUseCase patch contract', () => {
  test('an explicit null clears end_date and total_installments and persists the blank values', async () => {
    const stack = buildUseCase(storedRecurrence());

    const updated = await stack.useCase.execute('rec-1', { end_date: null, total_installments: null });

    expect(updated.end_date).toBe('');
    expect(updated.total_installments).toBe(0);
    expect(updated.name).toBe('Aluguel');
    expect(updated.amount).toBe(100);
    expect(updated.payday).toBe(5);
    expect(updated.account_id).toBe('acc-1');
    expect(updated.category_id).toBe('cat-1');

    const stored = await stack.recurrences.findById('rec-1');
    expect(stored.end_date).toBe('');
    expect(stored.total_installments).toBe(0);
  });

  test('switching origin clears the account relation explicitly and keeps a single card origin', async () => {
    const stack = buildUseCase(storedRecurrence());

    const updated = await stack.useCase.execute('rec-1', { account_id: null, card_id: 'card-1' });

    expect(updated.account_id).toBe('');
    expect(updated.card_id).toBe('card-1');
    expect(updated.status).toBe('active');
  });

  test('a patch that keeps both origins nonnull is rejected before any write', async () => {
    const stack = buildUseCase(storedRecurrence());

    await expect(stack.useCase.execute('rec-1', { card_id: 'card-1' })).rejects.toBeInstanceOf(ValidationError);

    const stored = await stack.recurrences.findById('rec-1');
    expect(stored.account_id).toBe('acc-1');
    expect(stored.card_id).toBe('');
  });

  test('the final state is validated after the patch is applied', async () => {
    const stack = buildUseCase(storedRecurrence());

    await expect(stack.useCase.execute('rec-1', { payday: 32 })).rejects.toBeInstanceOf(ValidationError);
    await expect(stack.useCase.execute('rec-1', { amount: 0 })).rejects.toBeInstanceOf(ValidationError);

    const stored = await stack.recurrences.findById('rec-1');
    expect(stored.payday).toBe(5);
    expect(stored.amount).toBe(100);
  });
});
