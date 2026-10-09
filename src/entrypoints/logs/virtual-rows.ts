import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  type VirtualItem,
} from '@tanstack/react-virtual';

interface VirtualRowsSnapshot {
  height: number;
  items: readonly VirtualItem[];
}

/** Publish stable row snapshots; React never reads the virtualizer's mutable instance. */
export function createVirtualRows() {
  let keys: readonly string[] = [];
  let element: HTMLDivElement | null = null;
  let snapshot: VirtualRowsSnapshot = { height: 0, items: [] };
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = {
      height: virtualizer.getTotalSize(),
      items: virtualizer.getVirtualItems().map((item) => ({ ...item })),
    };

    for (const listener of listeners) listener();
  };

  const virtualizer = new Virtualizer<HTMLDivElement, Element>({
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => keys[index] ?? String(index),
    observeElementOffset,
    observeElementRect,
    scrollToFn: elementScroll,
    onChange: publish,
  });

  let unmount = () => {};

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    attach: (node: HTMLDivElement | null) => {
      unmount();
      element = node;
      unmount = node ? virtualizer._didMount() : () => {};

      virtualizer._willUpdate();
      publish();
    },
    setKeys: (next: readonly string[]) => {
      if (keys.length === next.length && keys.every((key, index) => key === next[index])) return;

      keys = next;

      virtualizer.setOptions({
        ...virtualizer.options,
        count: keys.length,
        getItemKey: (index) => keys[index] ?? String(index),
      });
      virtualizer._willUpdate();
      publish();
    },
    measure: (node: Element | null) => virtualizer.measureElement(node),
  };
}
