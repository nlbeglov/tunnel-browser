// Preload of the ⋮ menu page (menu.html): it only shows items and reports the choice.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppMenuShow } from '../shared/types';

contextBridge.exposeInMainWorld('menu', {
  onShow(cb: (data: AppMenuShow) => void) {
    const fn = (_e: IpcRendererEvent, data: AppMenuShow) => cb(data);
    ipcRenderer.on('menu:show', fn);
    return () => ipcRenderer.removeListener('menu:show', fn);
  },
  choose: (id: string) => ipcRenderer.send('menu:choose', id),
  close: () => ipcRenderer.send('menu:close'),
});
