const scopedDeletionDestinations = new Map();
function destinationKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 128);
}
/**
 * Register only a backend client that is actually injected into the deletion
 * runtime. Configuration flags alone never establish this capability.
 */
export function registerScopedBackendDeletionCapability(destination) {
    const key = destinationKey(destination);
    if (!key)
        return () => undefined;
    scopedDeletionDestinations.set(key, (scopedDeletionDestinations.get(key) ?? 0) + 1);
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const remaining = (scopedDeletionDestinations.get(key) ?? 1) - 1;
        if (remaining > 0)
            scopedDeletionDestinations.set(key, remaining);
        else
            scopedDeletionDestinations.delete(key);
    };
}
export function hasScopedBackendDeletionCapability(destination) {
    return (scopedDeletionDestinations.get(destinationKey(destination)) ?? 0) > 0;
}
