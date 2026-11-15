declare module 'node:test' {
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: () => void | Promise<void>): Promise<void>;
}

declare module 'node:assert/strict' {
  function assert(value: unknown, message?: string | Error): asserts value;
  namespace assert {
    function ok(value: unknown, message?: string | Error): asserts value;
    function equal<T>(actual: T, expected: T, message?: string | Error): void;
    function notEqual<T>(actual: T, expected: T, message?: string | Error): void;
    function deepEqual<T>(actual: T, expected: T, message?: string | Error): void;
    function match(value: string, regexp: RegExp, message?: string | Error): void;
    function doesNotMatch(value: string, regexp: RegExp, message?: string | Error): void;
    function throws(
      block: () => unknown,
      error?: RegExp | (new (...args: never[]) => Error),
      message?: string | Error,
    ): void;
    function rejects(
      block: () => Promise<unknown>,
      error?: RegExp | (new (...args: never[]) => Error),
      message?: string | Error,
    ): Promise<void>;
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

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  export const sep: string;
}

declare module 'node:fs/promises' {
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function writeFile(path: string, data: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function lstat(path: string): Promise<unknown>;
}
