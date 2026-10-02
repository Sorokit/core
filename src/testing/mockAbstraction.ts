type MockImplementation<Arguments extends unknown[], Return> = (...args: Arguments) => Return;

export interface MockFunction<Arguments extends unknown[] = unknown[], Return = unknown> {
  (...args: Arguments): Return;
  mock: { calls: Arguments[] };
  mockClear(): this;
  mockReset(): this;
  mockImplementation(implementation: MockImplementation<Arguments, Return>): this;
  mockImplementationOnce(implementation: MockImplementation<Arguments, Return>): this;
  mockReturnValue(value: Return): this;
  mockReturnValueOnce(value: Return): this;
  mockResolvedValue(value: Awaited<Return>): this;
  mockResolvedValueOnce(value: Awaited<Return>): this;
  mockRejectedValue(error: unknown): this;
  mockRejectedValueOnce(error: unknown): this;
  mockReturnThis(): this;
  mockRestore(): void;
}

interface MockRunner {
  fn: (...args: unknown[]) => MockFunction;
  spyOn: (object: object, method: PropertyKey) => MockFunction;
}

function getRunner(): MockRunner {
  const globals = globalThis as typeof globalThis & {
    vi?: MockRunner;
    jest?: MockRunner;
  };
  const runner = globals.vi ?? globals.jest;

  if (!runner) {
    throw new Error(
      "No supported test runner detected. Run this helper inside Vitest or Jest.",
    );
  }

  return runner;
}

export function createMockFunction<Arguments extends unknown[] = unknown[], Return = unknown>(
  implementation?: MockImplementation<Arguments, Return>,
): MockFunction<Arguments, Return> {
  const runner = getRunner();
  return runner.fn(implementation as unknown as (...args: unknown[]) => unknown) as unknown as MockFunction<
    Arguments,
    Return
  >;
}

export function spyOn<Object extends object, Method extends keyof Object>(
  object: Object,
  method: Method,
): Object[Method] extends (...args: infer Arguments) => infer Return
  ? MockFunction<Arguments, Return>
  : never {
  return getRunner().spyOn(object, method as PropertyKey) as never;
}