// Thin dispatch boundary between Elysia controllers and application use cases.
//
// A controller declares the HTTP surface (route, TypeBox schemas, status) and
// maps its validated transport inputs to the use-case's `execute(...)` args;
// this helper does the rest: resolve the registered use case from the
// request's Awilix container and invoke `execute` once. Domain errors are not
// wrapped here — they bubble to `../plugins/errorPlugin` unchanged.
//
// Crons/scheduled jobs must keep resolving their use cases directly from
// Awilix (see `../scheduler`); they never go through this HTTP helper.

import { AwilixContainer } from 'awilix';
import { UseCaseRegistry, UseCaseToken } from './registry';

type UseCaseInput<K extends UseCaseToken> = Parameters<UseCaseRegistry[K]['execute']>;
type UseCaseExecutor<K extends UseCaseToken> =
  (this: UseCaseRegistry[K], ...args: UseCaseInput<K>) => ReturnType<UseCaseRegistry[K]['execute']>;

/**
 * Resolves the use case registered under `token` and executes it with `args`.
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
 * Typed resolution only, for handlers that compose more than one use case
 * (e.g. the background job endpoints). Prefer `executeUseCase` otherwise.
 */
export function resolveUseCase<K extends UseCaseToken>(
  container: AwilixContainer,
  token: K
): UseCaseRegistry[K] {
  return container.resolve<UseCaseRegistry[K]>(token);
}
