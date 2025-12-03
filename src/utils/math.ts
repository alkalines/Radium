const unfuckJSMath = 100000000000;
export const AddFunction = (numbers: number[]) =>
  numbers
    .filter((m) => parseFloat(m.toString()))
    .map((m) => m * unfuckJSMath)
    .map((m) => parseInt(m.toFixed(0))) // Repeating decimal will mess JS fucked math
    .reduce((accumulator, currentValue) => {
      return accumulator + currentValue;
    }, 0) / unfuckJSMath;
export const MultiplyFunction = (numbers: number[]) =>
  numbers
    .filter((m) => parseFloat(m.toString()))
    .map((m) => m * unfuckJSMath)
    .map((m) => parseInt(m.toFixed(0)))
    .reduce((accumulator, currentValue) => {
      return accumulator * currentValue;
    }, 1) /
  unfuckJSMath ** numbers.length;
