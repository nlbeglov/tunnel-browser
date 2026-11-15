import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BridgeApi } from '../shared/types';

const call = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: IpcRendererEvent, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

const api: BridgeApi = {
  profiles: {
    get: () => call('profiles:get'),
    importText: (text) => call('profiles:import', text),
    remove: (id) => call('profiles:remove', id),
    select: (id) => call('profiles:select', id),
    addSubscription: (url) => call('subs:add', url),
    refreshSubscription: (id) => call('subs:refresh', id),
    removeSubscription: (id) => call('subs:remove', id),
    onChange: (cb) => listen('profiles:changed', cb),
  },
  tunnel: {
    get: () => call('tunnel:get'),
    connect: (id) => call('tunnel:connect', id),
    disconnect: () => call('tunnel:disconnect'),
    onChange: (cb) => listen('tunnel:changed', cb),
  },
  tabs: {
    get: () => call('tabs:get'),
    create: (input) => call('tabs:create', input),
    close: (id) => call('tabs:close', id),
    activate: (id) => call('tabs:activate', id),
    navigate: (id, input) => call('tabs:navigate', id, input),
    back: (id) => call('tabs:back', id),
    forward: (id) => call('tabs:forward', id),
    reload: (id) => call('tabs:reload', id),
    stop: (id) => call('tabs:stop', id),
    setBounds: (rect) => ipcRenderer.send('tabs:bounds', rect),
    setOverlay: (open) => ipcRenderer.send('tabs:overlay', open),
    onChange: (cb) => listen('tabs:changed', cb),
    onFocusAddressBar: (cb) => listen('ui:focus-address', cb),
  },
  updates: {
    get: () => call('updates:get'),
    check: () => call('updates:check'),
    install: () => call('updates:install'),
    history: () => call('updates:history'),
    onChange: (cb) => listen('updates:changed', cb),
  },
  app: {
    info: () => call('app:info'),
    clearBrowsingData: () => call('app:clear-data'),
  },
};

contextBridge.exposeInMainWorld('api', api);
