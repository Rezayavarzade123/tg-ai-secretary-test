// Redirects the platform-only imports `sdk` and `sdk/db` to the local fake.
export async function resolve(specifier, context, next) {
  if (specifier === 'sdk' || specifier === 'sdk/db') {
    return { url: new URL('./fake-sdk.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
