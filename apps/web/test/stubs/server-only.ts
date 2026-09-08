/**
 * `server-only` throws on import outside a React Server Component, which is
 * exactly its job and exactly what makes it unimportable from a unit test. The
 * modules it guards are plain functions under Node, so vitest resolves the
 * package to this no-op instead of losing coverage of everything downstream of
 * it.
 */
export {}
