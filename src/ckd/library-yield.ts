// Library maintenance shares the HTTP server's event loop. A resolved Promise
// only yields to microtasks; setImmediate lets pending HTTP and timers run.
export async function yieldLibraryTurn(signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    signal.throwIfAborted();
}
