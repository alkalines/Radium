const decimalScale = 100000000000;

// Preserve the filtering and fixed-scale rounding used by persisted usage estimates.
function scaledNonZeroNumbers(numbers: number[]) {
  return numbers
    .filter((number) => parseFloat(number.toString()))
    .map((number) => number * decimalScale)
    .map((number) => parseInt(number.toFixed(0)));
}

/** Sum non-zero inputs after rounding them to the legacy fixed decimal scale. */
export const AddFunction = (numbers: number[]) =>
  scaledNonZeroNumbers(numbers).reduce((total, number) => total + number, 0) / decimalScale;

/** Subtract each non-zero input from zero using the legacy fixed decimal scale. */
export const RemFunction = (numbers: number[]) =>
  scaledNonZeroNumbers(numbers).reduce((total, number) => total - number, 0) / decimalScale;

/** Multiply non-zero inputs using the original input count for legacy scale normalization. */
export const MultiplyFunction = (numbers: number[]) =>
  scaledNonZeroNumbers(numbers).reduce((product, number) => product * number, 1) /
  decimalScale ** numbers.length;
