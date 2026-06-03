export class DomainError extends Error {
  constructor(message: string, public readonly code: string = 'DOMAIN_ERROR') {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 'NOT_FOUND');
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT');
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class ExpiredError extends DomainError {
  constructor(message: string) {
    super(message, 'EXPIRED');
  }
}
