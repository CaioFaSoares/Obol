// Thin dispatch boundary between Elysia controllers and application use cases.
//
// A controller declares the HTTP surface (route, TypeBox schemas, status) and
// maps its validated transport inputs to the use-case's `execute(...)` args;
// these helpers do the rest. Two dispatch families:
//
// - reads resolve the registered use case straight from the request's Awilix
//   container and invoke `execute` once (raw read-only repositories);
// - every financial WRITE resolves the typed `FinancialMutationRuntime`
//   registered in the same container and routes the mutation through the
//   shared FIFO gate with one unit of work; controllers never resolve raw
//   writers, schedulers and the admin reset share the same executor with
//   their own origin (`job`/`admin`).
//
// Domain errors are not wrapped here — they bubble to
// `../plugins/errorPlugin` unchanged; gate rejections surface as the typed
// `MutationPreconditionError` they are.

import { AwilixContainer } from 'awilix';
import type { FinancialMutationRuntime } from '../sync/FinancialMutationRuntime';
import { UseCaseRegistry, UseCaseToken } from './registry';

type UseCaseInput<K extends UseCaseToken> = Parameters<UseCaseRegistry[K]['execute']>;
type UseCaseExecutor<K extends UseCaseToken> =
  (this: UseCaseRegistry[K], ...args: UseCaseInput<K>) => ReturnType<UseCaseRegistry[K]['execute']>;

/** Typed container resolution: the runtime backs every mutation dispatch. */
export function mutationRuntimeOf(
  container: AwilixContainer,
): FinancialMutationRuntime {
  return container.resolve<FinancialMutationRuntime>('syncRuntime');
}

/**
 * Resolves the use case registered under `token` and executes it with `args`
 * against the raw read-only repositories of the request container.
 *
 * The literal token pins the resolved class type, so `args` are checked against
 * that exact `execute(...)` signature and the returned value keeps its real
 * type for Elysia/Eden inference.
 */
export function executeUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K,
  ...args: UseCaseInput<K>
): ReturnType<UseCaseRegistry[K]['execute']> {
  const instance = container.resolve<UseCaseRegistry[K]>(token);
  const execute = instance.execute as UseCaseExecutor<K>;
  return execute.call(instance, ...args);
}

/**
 * Financial write dispatch: one FIFO gate slot, one unit of work, one atomic
 * PocketBase batch — resolved from the typed runtime registered in the same
 * container. `local` role records its durable canonical intent in the very
 * same commit; `web` mutation rejections surface as their typed
 * precondition, never as a silent half-write.
 */
export function executeMutationUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K,
  ...args: UseCaseInput<K>
): Promise<Awaited<ReturnType<UseCaseRegistry[K]['execute']>>> {
  return mutationRuntimeOf(container).execute(token, args, 'web');
}

/**
 * Scheduled job dispatch (origin `job`): the exact same FIFO gate, unit of
 * work and local intent recording as the HTTP write routes.
 */
export function executeJobUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K,
  ...args: UseCaseInput<K>
): Promise<Awaited<ReturnType<UseCaseRegistry[K]['execute']>>> {
  return mutationRuntimeOf(container).execute(token, args, 'job');
}

/**
 * Admin dispatch (origin `admin`): the exact same FIFO gate, unit of work
 * and reset semantics as the other mutation origins.
 */
export function executeAdminUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K,
  ...args: UseCaseInput<K>
): Promise<Awaited<ReturnType<UseCaseRegistry[K]['execute']>>> {
  return mutationRuntimeOf(container).execute(token, args, 'admin');
}

/**
 * Typed resolution only, for handlers that compose more than one use case
 * (read compositions). Write responsibilities go through the runtime.
 */
export function resolveUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K
): UseCaseRegistry[K] {
  return container.resolve<UseCaseRegistry[K]>(token);
}
