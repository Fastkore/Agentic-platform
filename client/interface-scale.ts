export function interfaceScale(element: Element) {
  return Number(getComputedStyle(element).getPropertyValue('--interface-scale')) || 1;
}
