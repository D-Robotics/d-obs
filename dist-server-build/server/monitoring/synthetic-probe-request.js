export function isSyntheticSsoCallbackProbe(request) {
    if (String(request.path ?? '') !== '/api/sso/callback')
        return false;
    if (!request.query || typeof request.query !== 'object')
        return false;
    const code = request.query.code;
    return typeof code === 'string' && code.trim().toLowerCase() === 'fake';
}
