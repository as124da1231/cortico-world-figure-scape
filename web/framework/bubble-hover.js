/** Only a pointer entering the bubble can hold it, including while the bubble reflows. */
export function createBubbleHover() {
  let previous, wasInside = false, holding = false;
  return {
    open() { previous = undefined; wasInside = holding = false; },
    sample(inside, point) {
      if (!inside) holding = false;
      else if (!wasInside && previous !== undefined && point &&
        (point.x !== previous?.x || point.y !== previous?.y)) holding = true;
      wasInside = inside;
      previous = point ?? null;
      return holding;
    },
  };
}
