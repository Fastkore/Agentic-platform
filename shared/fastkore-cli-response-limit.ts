export const defaultToolResponseChars = 96_000;
export const maxFastkoreCliResponseChars = 200_000;

export function isFastkoreCliResponseLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= defaultToolResponseChars && value <= maxFastkoreCliResponseChars;
}
