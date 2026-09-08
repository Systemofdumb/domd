import { createContext, useContext, useState, createElement } from "react";
import { BaseStore } from "../core/BaseStore";
import { useStoreSelector } from "./useStoreSelector";

type ConstructorParameters<T> = T extends new () => any
  ? undefined
  : T extends new (props: infer P) => any
  ? P
  : never;

type InstanceType<T> = T extends new (...args: any[]) => infer R ? R : never;

export function createReactStore<
  TStoreConstructor extends new (...args: any[]) => BaseStore<any>,
>(StoreClass: TStoreConstructor) {
  type TStore = InstanceType<TStoreConstructor>;
  type TProps = ConstructorParameters<TStoreConstructor>;

  const StoreContext = createContext<TStore | null>(null);

  type StoreProviderProps = (TProps extends undefined
    ? { children: React.ReactNode; initialProps?: undefined }
    : { children: React.ReactNode; initialProps: TProps }) & {
    /** Bring your own store: mount the provider onto an EXISTING store
     *  instance the host owns, instead of constructing one internally. When
     *  given, `initialProps` is ignored — the store was already built. The
     *  host owns the lifecycle (the provider never destroys it), which is
     *  what lets a document runtime outlive its view: keep the store, remount
     *  the tree. Captured once on mount — to switch stores, remount with a
     *  new `key`. */
    store?: TStore;
  };

  const StoreProvider = ({
    children,
    initialProps,
    store: externalStore,
  }: StoreProviderProps) => {
    const [store] = useState<TStore>(
      () => externalStore ?? (new StoreClass(initialProps as TProps) as TStore),
    );
    return createElement(StoreContext.Provider, { value: store }, children);
  };

  const useStoreApi = () => {
    const store = useContext(StoreContext);
    if (!store) {
      throw new Error("useStore must be used within a StoreProvider");
    }
    return store;
  };

  const useStore = <T,>(selector: (store: TStore) => T): T => {
    const store = useContext(StoreContext);
    if (!store) {
      throw new Error("useStore must be used within a StoreProvider");
    }
    return useStoreSelector(store, selector);
  };

  return { StoreProvider, useStoreApi, useStore };
}
