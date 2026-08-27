export type ApiErrorParams = Record<string, string | number>;

/** Next-free so restore one-offs can bundle callers such as the config store. */
export class ApiError extends Error {
  status: number;
  code: string;
  params?: ApiErrorParams;
  constructor(status: number, code: string, params?: ApiErrorParams) {
    super(code);
    this.status = status;
    this.code = code;
    this.params = params;
  }
}
