export class DeadlineExceeded extends Error {
  constructor() {
    super("deadline_exceeded");
    this.name = "DeadlineExceeded";
  }
}

export async function withDeadline(operation, timeoutMs, onTimeout = () => {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("invalid_timeout");
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      try {
        onTimeout();
      } finally {
        reject(new DeadlineExceeded());
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}
