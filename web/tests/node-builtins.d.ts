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
    function doesNotThrow(block: () => unknown, message?: string | Error): void;
    function doesNotReject(block: () => Promise<unknown>, message?: string | Error): Promise<void>;
  }
  export default assert;
}

declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
  export function readFileSync(path: string | URL): Uint8Array;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
