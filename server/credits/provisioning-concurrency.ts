/**
 * Per-owner single-flight for login-time provisioning.
 *
 * A process can receive several restore/login callbacks for the same account
 * at once. Sharing one promise keeps those callbacks from issuing duplicate
 * gateway creates (which are destructive when the gateway's create endpoint
 * resets an existing user key). Failed flights are removed so a transient
 * failure never poisons later recovery.
 */
export function createOwnerSingleFlight<T>(
  run: (ownerId: string) => Promise<T>,
): (ownerId: string) => Promise<T> {
  const flights = new Map<string, Promise<T>>();
  return (ownerId: string): Promise<T> => {
    const id = String(ownerId ?? '').trim();
    if (!id) return run(id);
    const existing = flights.get(id);
    if (existing) return existing;
    const flight = Promise.resolve().then(() => run(id));
    flights.set(id, flight);
    void flight.then(
      () => {
        if (flights.get(id) === flight) flights.delete(id);
      },
      () => {
        if (flights.get(id) === flight) flights.delete(id);
      },
    );
    return flight;
  };
}
