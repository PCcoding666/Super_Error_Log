export type AiErrorKind = 'timeout' | 'invalid_json' | 'rate_limited' | 'provider_error' | 'unsupported';

export class AiError extends Error {
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}
