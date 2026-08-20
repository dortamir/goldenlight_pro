import { isolateLTR } from '../utils/bidiText';

export const MIN_PASSWORD_LENGTH = 8;

export const PASSWORD_TOO_SHORT_MESSAGE = `הסיסמה חייבת להכיל לפחות ${isolateLTR(MIN_PASSWORD_LENGTH)} תווים`;
