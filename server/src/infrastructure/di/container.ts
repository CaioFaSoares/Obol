import { createContainer, asClass, asValue, InjectionMode } from 'awilix';
import { pb } from '../plugins/pocketbase';

// Import Repositories
import { PocketbaseTransactionRepository } from '../repositories/PocketbaseTransactionRepository';
import { PocketbaseAccountRepository } from '../repositories/PocketbaseAccountRepository';
import { PocketbaseCardRepository } from '../repositories/PocketbaseCardRepository';
import { PocketbaseInvoiceRepository } from '../repositories/PocketbaseInvoiceRepository';
import { PocketbaseRecurrenceRepository } from '../repositories/PocketbaseRecurrenceRepository';
import { PocketbaseCategoryRepository } from '../repositories/PocketbaseCategoryRepository';
import { PocketbaseProjectRepository } from '../repositories/PocketbaseProjectRepository';

// Import Use Cases
import { SyncInvoiceUseCase } from '../../application/use-cases/invoices/SyncInvoiceUseCase';
import { CreateTransactionUseCase } from '../../application/use-cases/transactions/CreateTransactionUseCase';
import { DeleteTransactionUseCase } from '../../application/use-cases/transactions/DeleteTransactionUseCase';
import { UpdateTransactionUseCase } from '../../application/use-cases/transactions/UpdateTransactionUseCase';
import { RealizeTransactionUseCase } from '../../application/use-cases/transactions/RealizeTransactionUseCase';
import { ListTransactionsUseCase } from '../../application/use-cases/transactions/ListTransactionsUseCase';
import { GenerateForecastUseCase } from '../../application/use-cases/forecast/GenerateForecastUseCase';
import { ListCardsUseCase } from '../../application/use-cases/cards/ListCardsUseCase';
import { CreateCardUseCase } from '../../application/use-cases/cards/CreateCardUseCase';
import { UpdateCardUseCase } from '../../application/use-cases/cards/UpdateCardUseCase';
import { GetCardInvoicesUseCase } from '../../application/use-cases/cards/GetCardInvoicesUseCase';
import { PayInvoiceUseCase } from '../../application/use-cases/cards/PayInvoiceUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/cards/DeleteInvoiceUseCase';
import { ListRecurrencesUseCase } from '../../application/use-cases/recurrences/ListRecurrencesUseCase';
import { CreateRecurrenceUseCase } from '../../application/use-cases/recurrences/CreateRecurrenceUseCase';
import { UpdateRecurrenceUseCase } from '../../application/use-cases/recurrences/UpdateRecurrenceUseCase';
import { DeleteRecurrenceUseCase } from '../../application/use-cases/recurrences/DeleteRecurrenceUseCase';
import { ToggleRecurrenceStatusUseCase } from '../../application/use-cases/recurrences/ToggleRecurrenceStatusUseCase';
import { LaunchRecurrenceUseCase } from '../../application/use-cases/recurrences/LaunchRecurrenceUseCase';
import { ProcessMonthlyRecurrencesUseCase } from '../../application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase';
import { GetRecurrenceTransactionsUseCase } from '../../application/use-cases/recurrences/GetRecurrenceTransactionsUseCase';
import { ListCategoriesUseCase } from '../../application/use-cases/categories/ListCategoriesUseCase';
import { GetBudgetsUseCase } from '../../application/use-cases/categories/GetBudgetsUseCase';
import { CreateCategoryUseCase } from '../../application/use-cases/categories/CreateCategoryUseCase';
import { ListProjectsUseCase } from '../../application/use-cases/projects/ListProjectsUseCase';
import { CreateProjectUseCase } from '../../application/use-cases/projects/CreateProjectUseCase';
import { RegisterPaymentUseCase } from '../../application/use-cases/projects/RegisterPaymentUseCase';
import { CompleteProjectUseCase } from '../../application/use-cases/projects/CompleteProjectUseCase';
import { ReconcileInvoicesUseCase } from '../../application/use-cases/reconciliation/ReconcileInvoicesUseCase';
import { ListAccountsUseCase } from '../../application/use-cases/accounts/ListAccountsUseCase';
import { CreateAccountUseCase } from '../../application/use-cases/accounts/CreateAccountUseCase';

export const container = createContainer({
  injectionMode: InjectionMode.CLASSIC
});

container.register({
  // Infrastructure / Global Clients
  pb: asValue(pb),

  // Repositories
  transactionRepository: asClass(PocketbaseTransactionRepository).singleton(),
  accountRepository: asClass(PocketbaseAccountRepository).singleton(),
  cardRepository: asClass(PocketbaseCardRepository).singleton(),
  invoiceRepository: asClass(PocketbaseInvoiceRepository).singleton(),
  recurrenceRepository: asClass(PocketbaseRecurrenceRepository).singleton(),
  categoryRepository: asClass(PocketbaseCategoryRepository).singleton(),
  projectRepository: asClass(PocketbaseProjectRepository).singleton(),

  // Use Cases
  syncInvoiceUseCase: asClass(SyncInvoiceUseCase).scoped(),
  createTransactionUseCase: asClass(CreateTransactionUseCase).scoped(),
  deleteTransactionUseCase: asClass(DeleteTransactionUseCase).scoped(),
  updateTransactionUseCase: asClass(UpdateTransactionUseCase).scoped(),
  realizeTransactionUseCase: asClass(RealizeTransactionUseCase).scoped(),
  listTransactionsUseCase: asClass(ListTransactionsUseCase).scoped(),
  generateForecastUseCase: asClass(GenerateForecastUseCase).scoped(),
  listCardsUseCase: asClass(ListCardsUseCase).scoped(),
  createCardUseCase: asClass(CreateCardUseCase).scoped(),
  updateCardUseCase: asClass(UpdateCardUseCase).scoped(),
  getCardInvoicesUseCase: asClass(GetCardInvoicesUseCase).scoped(),
  payInvoiceUseCase: asClass(PayInvoiceUseCase).scoped(),
  deleteInvoiceUseCase: asClass(DeleteInvoiceUseCase).scoped(),
  listRecurrencesUseCase: asClass(ListRecurrencesUseCase).scoped(),
  createRecurrenceUseCase: asClass(CreateRecurrenceUseCase).scoped(),
  updateRecurrenceUseCase: asClass(UpdateRecurrenceUseCase).scoped(),
  deleteRecurrenceUseCase: asClass(DeleteRecurrenceUseCase).scoped(),
  toggleRecurrenceStatusUseCase: asClass(ToggleRecurrenceStatusUseCase).scoped(),
  launchRecurrenceUseCase: asClass(LaunchRecurrenceUseCase).scoped(),
  processMonthlyRecurrencesUseCase: asClass(ProcessMonthlyRecurrencesUseCase).scoped(),
  getRecurrenceTransactionsUseCase: asClass(GetRecurrenceTransactionsUseCase).scoped(),
  listCategoriesUseCase: asClass(ListCategoriesUseCase).scoped(),
  getBudgetsUseCase: asClass(GetBudgetsUseCase).scoped(),
  createCategoryUseCase: asClass(CreateCategoryUseCase).scoped(),
  listProjectsUseCase: asClass(ListProjectsUseCase).scoped(),
  createProjectUseCase: asClass(CreateProjectUseCase).scoped(),
  registerPaymentUseCase: asClass(RegisterPaymentUseCase).scoped(),
  completeProjectUseCase: asClass(CompleteProjectUseCase).scoped(),
  reconcileInvoicesUseCase: asClass(ReconcileInvoicesUseCase).scoped(),
  listAccountsUseCase: asClass(ListAccountsUseCase).scoped(),
  createAccountUseCase: asClass(CreateAccountUseCase).scoped(),
});
