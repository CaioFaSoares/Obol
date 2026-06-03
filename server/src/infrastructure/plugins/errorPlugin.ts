import { Elysia } from 'elysia';
import { NotFoundError, ConflictError, ValidationError, ExpiredError } from '../../domain/errors';

export const errorPlugin = new Elysia({ name: 'error-plugin' })
  .error({
    NotFoundError,
    ConflictError,
    ValidationError,
    ExpiredError,
  })
  .onError(({ code, error, set }) => {
    switch (code) {
      case 'NotFoundError':
        set.status = 404;
        return { error: 'Not Found', details: error.message };
      case 'ConflictError':
        set.status = 409;
        return { error: 'Conflict', details: error.message };
      case 'ValidationError':
        set.status = 400;
        return { error: 'Validation Error', details: error.message };
      case 'ExpiredError':
        set.status = 410;
        return { error: 'Expired', details: error.message };
      case 'VALIDATION':
        set.status = 400;
        return { error: 'Bad Request', details: error.message, errors: (error as any).all };
      default:
        console.error('Unhandled server error:', error);
        set.status = 500;
        return { error: 'Internal Server Error', details: error.message };
    }
  });
