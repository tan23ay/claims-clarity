export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND', 'Record not found or not authorized.');

export function objectBody(value, allowed, required = []) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new ApiError(400, 'INVALID_BODY', 'A JSON object is required.');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'UNKNOWN_FIELD', 'The request contains unsupported fields.');
  if (required.some(key => value[key] === undefined)) throw new ApiError(400, 'MISSING_FIELD', 'The request is missing a required field.');
  return value;
}

export function textField(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'INVALID_FIELD', `Invalid ${label}.`);
  return value.trim();
}
