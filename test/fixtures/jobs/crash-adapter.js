// A stand-in adapter for test/jobs.test.js whose worker dies mid-run, the way a native
// crash would take it: after the run row is open, before the run can close it.

export default {
  id: 'crash',
  name: 'Crashing test source',
  base: 'https://crash.test',
  async *list() {
    // Long enough for the worker's "run opened" message to reach the web process.
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(process.pid, 'SIGKILL');
    yield* [];
  },
  async detail() {
    return null;
  },
};
