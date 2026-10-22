// Redirects the platform-only imports `sdk` and `sdk/db` to the local runtime.
// This is what lets tgcloud/handlers/*.js run on your own machine untouched.
export async function resolve(specifier, context, next) {
  if (specifier === 'sdk') {
    return { url: new URL('./sdk/index.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === 'sdk/db') {
    return { url: new URL('./sdk/db.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
