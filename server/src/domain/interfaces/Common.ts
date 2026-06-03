export interface PaginatedResult<T> {
  items: T[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export interface ListOptions {
  sort?: string;
  filter?: string;
  page?: number;
  perPage?: number;
  expand?: string;
}
