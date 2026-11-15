/** An expected application failure, safe to expose through the API envelope. */
export class DomainError extends Error {
  constructor(public statusCode: number, public code: string, public commit = false, options?: ErrorOptions) { super(code, options); }
}
