declare module 'node:test' {
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: () => void | Promise<void>): Promise<void>;
}

declare module 'node:assert/strict' {
  function assert(value: unknown, message?: string | Error): asserts value;
  namespace assert {
    function equal<T>(actual: T, expected: T, message?: string | Error): void;
    function notEqual<T>(actual: T, expected: T, message?: string | Error): void;
    function deepEqual<T>(actual: T, expected: T, message?: string | Error): void;
    function throws(
      block: () => unknown,
      error?: RegExp | (new (...args: never[]) => Error),
      message?: string | Error,
    ): void;
  }
  export default assert;
}
