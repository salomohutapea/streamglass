import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

// The guest receives serialized data only; no host functions or Node objects cross in.
try {
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 750;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext();
  try {
    const input = JSON.stringify(workerData);
    const program = `
      globalThis.__result = undefined;
      globalThis.__error = undefined;
      (async () => {
        const input = ${input};
        const logs = [];
        const console = Object.freeze({ log: (...args) => {
          if (logs.length < 100) logs.push(args.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 2000));
        }});
        ${workerData.source}
        const hooks = {
          onRequest: typeof onRequest === 'function' ? onRequest : undefined,
          onResponse: typeof onResponse === 'function' ? onResponse : undefined,
          onEvent: typeof onEvent === 'function' ? onEvent : undefined
        };
        const fn = hooks[input.hook];
        const value = input.hook === 'onRequest' ? input.request : input.hook === 'onResponse' ? input.response : input.event;
        const args = [input.context || {}, input.url, input.request];
        if (input.hook === 'onResponse') args.push(input.response);
        if (input.hook === 'onEvent') args.push(input.event);
        const result = fn ? await fn(...args) : value;
        globalThis.__result = JSON.stringify({ value: result === undefined ? value : result, logs });
      })().catch(error => { globalThis.__error = String(error); });
    `;
    const evaluated = context.evalCode(program, 'user-hook.js');
    if (evaluated.error) {
      const error = context.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(error?.message || String(error));
    }
    evaluated.value.dispose();
    while (runtime.hasPendingJob()) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const error = context.dump(jobs.error);
        jobs.error.dispose();
        throw new Error(error?.message || String(error));
      }
      if (Date.now() > deadline) throw new Error('Script exceeded execution deadline');
    }
    const failure = context.getProp(context.global, '__error');
    const failureText = context.dump(failure);
    failure.dispose();
    if (failureText) throw new Error(failureText);
    const result = context.getProp(context.global, '__result');
    const serialized = context.dump(result);
    result.dispose();
    if (typeof serialized !== 'string') throw new Error('Script returned an unresolved promise');
    if (serialized.length > 8 * 1024 * 1024) throw new Error('Script output exceeds 8 MiB');
    parentPort.postMessage({ ok: true, result: JSON.parse(serialized) });
  } finally {
    context.dispose();
    runtime.dispose();
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
