// @nanostores/react (and nanostores itself) ship no type declarations in this install, so stores are
// untyped. Provide the one hook the shell uses so `useStore($store)` resolves instead of erroring.
declare module '@nanostores/react' {
  export function useStore(store: any): any
}
