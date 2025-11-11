export async function* streamChunkForAsyncIterator(stream: ReadableStream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock(); // Release the lock on the reader when done or in case of error
  }
}
