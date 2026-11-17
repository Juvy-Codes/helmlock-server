// Same error shape the app expects (and Laravel's default):
// message = main message, errors = { fieldName: ['message'] }
export class ApiError extends Error {
  constructor(message, errors = {}, status = 422) {
    super(message);
    this.errors = errors;
    this.status = status;
  }
}

export function fail(field, message) {
  throw new ApiError(message, { [field]: [message] });
}
