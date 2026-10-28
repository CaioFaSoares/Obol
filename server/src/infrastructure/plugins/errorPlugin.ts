import { Elysia } from 'elysia';
import { NotFoundError, ConflictError, ValidationError, ExpiredError } from '../../domain/errors';

export const errorPlugin = new Elysia({ name: 'error-plugin' })
  .error({
    NotFoundError,
    ConflictError,
    ValidationError,
    ExpiredError,
  })
  .onError({ as: 'global' }, ({ code, error, set }) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NotFoundError) {
      set.status = 404;
      return { error: 'Not Found', details: message };
    }
    if (error instanceof ConflictError) {
      set.status = 409;
      return { error: 'Conflict', details: message };
    }
    if (error instanceof ValidationError) {
      set.status = 400;
      return { error: 'Validation Error', details: message };
    }
    if (error instanceof ExpiredError) {
      set.status = 410;
      return { error: 'Expired', details: message };
    }
    if (code === 'VALIDATION') {
      set.status = 400;
      const errors = 'all' in error ? error.all : undefined;
      return { error: 'Bad Request', details: message, errors };
    }
    console.error(`Unhandled server error (code=${code}):`, error);
    set.status = 500;
    return { error: 'Internal Server Error', details: message };
  });
