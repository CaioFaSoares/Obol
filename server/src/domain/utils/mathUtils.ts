/**
 * Arredonda um valor para garantir que não haja lixo de floating-point (ex: 120.30000000000001 -> 120.30)
 */
export function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Soma dois valores monetários de forma segura
 */
export function sum(a: number, b: number): number {
  return roundCurrency(a + b);
}

/**
 * Subtrai dois valores monetários de forma segura (a - b)
 */
export function sub(a: number, b: number): number {
  return roundCurrency(a - b);
}

/**
 * Multiplica dois valores de forma segura (ex: aplicar juros ou porcentagem)
 */
export function mul(a: number, b: number): number {
  return roundCurrency(a * b);
}
