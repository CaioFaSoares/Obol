// Typed map from Awilix registration token to the concrete use-case class it
// resolves to. This is the single source of truth for the dispatch boundary:
// controllers resolve use cases by token through `executeUseCase`/`resolveUseCase`
// instead of casting the result of `container.resolve` themselves.
//
// Keeping this mapping next to the dispatcher means a token typo or an argument
// mismatch is a compile error (the helper learns the `execute(...)` signature of
// the exact class registered under the token), without changing how Awilix
// registers or scopes the use cases.

import { SyncInvoiceUseCase } from '../../application/use-cases/invoices/SyncInvoiceUseCase';
import { CreateTransactionUseCase } from '../../application/use-cases/transactions/CreateTransactionUseCase';
import { DeleteTransactionUseCase } from '../../application/use-cases/transactions/DeleteTransactionUseCase';
import { UpdateTransactionUseCase } from '../../application/use-cases/transactions/UpdateTransactionUseCase';
import { RealizeTransactionUseCase } from '../../application/use-cases/transactions/RealizeTransactionUseCase';
import { ListTransactionsUseCase } from '../../application/use-cases/transactions/ListTransactionsUseCase';
import { SummarizeTransactionsUseCase } from '../../application/use-cases/transactions/SummarizeTransactionsUseCase';
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
import { ResetFinancialDataUseCase } from '../../application/use-cases/maintenance/ResetFinancialDataUseCase';

export interface UseCaseRegistry {
  syncInvoiceUseCase: SyncInvoiceUseCase;

  createTransactionUseCase: CreateTransactionUseCase;
  deleteTransactionUseCase: DeleteTransactionUseCase;
  updateTransactionUseCase: UpdateTransactionUseCase;
  realizeTransactionUseCase: RealizeTransactionUseCase;
  listTransactionsUseCase: ListTransactionsUseCase;
  summarizeTransactionsUseCase: SummarizeTransactionsUseCase;

  generateForecastUseCase: GenerateForecastUseCase;

  listCardsUseCase: ListCardsUseCase;
  createCardUseCase: CreateCardUseCase;
  updateCardUseCase: UpdateCardUseCase;
  getCardInvoicesUseCase: GetCardInvoicesUseCase;
  payInvoiceUseCase: PayInvoiceUseCase;
  deleteInvoiceUseCase: DeleteInvoiceUseCase;

  listRecurrencesUseCase: ListRecurrencesUseCase;
  createRecurrenceUseCase: CreateRecurrenceUseCase;
  updateRecurrenceUseCase: UpdateRecurrenceUseCase;
  deleteRecurrenceUseCase: DeleteRecurrenceUseCase;
  toggleRecurrenceStatusUseCase: ToggleRecurrenceStatusUseCase;
  launchRecurrenceUseCase: LaunchRecurrenceUseCase;
  processMonthlyRecurrencesUseCase: ProcessMonthlyRecurrencesUseCase;
  getRecurrenceTransactionsUseCase: GetRecurrenceTransactionsUseCase;

  listCategoriesUseCase: ListCategoriesUseCase;
  getBudgetsUseCase: GetBudgetsUseCase;
  createCategoryUseCase: CreateCategoryUseCase;

  listProjectsUseCase: ListProjectsUseCase;
  createProjectUseCase: CreateProjectUseCase;
  registerPaymentUseCase: RegisterPaymentUseCase;
  completeProjectUseCase: CompleteProjectUseCase;

  reconcileInvoicesUseCase: ReconcileInvoicesUseCase;

  listAccountsUseCase: ListAccountsUseCase;
  createAccountUseCase: CreateAccountUseCase;

  resetFinancialDataUseCase: ResetFinancialDataUseCase;
}

export type UseCaseToken = keyof UseCaseRegistry;
