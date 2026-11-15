/** Resolve only after Node has completed closing the listening server. */
export function closeServer(server: { close(callback: (error?: Error) => void): unknown }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
