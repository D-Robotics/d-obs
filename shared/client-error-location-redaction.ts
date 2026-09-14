const POSIX_USER_HOME =
  /\/(Users|home)\/(?!\[USER\])(?:[^/\\\r\n"'`?&#:;,)\]}=]+(?=\/)|[^/\\\r\n"'`?&#:;,)\]}=]+?(?=[?&#:;,)\]}]|$)|[^/\\\s"'`?&#:;,)\]}=]+)/gi;
const WINDOWS_USER_HOME =
  /([A-Z]):\\Users\\(?!\[USER\])(?:[^/\\\r\n"'`?&#:;,)\]}=]+(?=\\)|[^/\\\r\n"'`?&#:;,)\]}=]+?(?=[?&#:;,)\]}]|$)|[^/\\\s"'`?&#:;,)\]}=]+)/gi;
const ABSOLUTE_LOCATION_QUERY =
  /((?:(?:https?|file):\/\/|\/|[A-Z]:\\)[^\s?#]*)[?#][^\s),;]+/gi;

/**
 * Removes the account-identifying segment from common local home directories
 * while retaining the project-relative suffix needed to diagnose a failure.
 */
export function redactLocalUserHomePaths(value: string): string {
  return value
    .replace(POSIX_USER_HOME, '/$1/[USER]')
    .replace(WINDOWS_USER_HOME, '$1:\\Users\\[USER]');
}

/**
 * Client-error locations may contain both a private home directory and signed
 * or credential-bearing query parameters. Preserve the useful file path only.
 */
export function sanitizeClientErrorLocations(value: string): string {
  return redactLocalUserHomePaths(value).replace(ABSOLUTE_LOCATION_QUERY, '$1');
}
