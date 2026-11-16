/** Serializes model and presentation commits for one Live2D body. */
export function createBodyTransaction() {
  let active: symbol | undefined;
  return {
    reserve(kind: 'model' | 'presentation') {
      if (active) throw Error('The body is busy; retry after the current operation finishes');
      const ticket = Symbol(kind);
      active = ticket;
      return () => { if (active === ticket) active = undefined; };
    },
  };
}

export type BodyTransaction = ReturnType<typeof createBodyTransaction>;
